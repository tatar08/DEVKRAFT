import {
  AgentHandoff,
  EnterpriseBuildPullRequestDraftInput,
  EnterpriseCollectHandoffInput,
  EnterpriseCollectRoleArtifactInput,
  EnterpriseGateRoleInput,
  EnterprisePullRequestDraft,
  EnterpriseRoleArtifact,
  EnterpriseRoleError,
  PullRequestEvidence,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isCodexLocalModel } from "../orchestration-v2/Adapters/CodexNamedProfile.ts";
import type * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type * as Git from "../vcs/GitVcsDriver.ts";
import type { PriceTable } from "./EnterpriseCost.ts";
import { renderEnterprisePullRequestDraft } from "./EnterprisePullRequestDraft.ts";
import { decodeEnterpriseRoleOutput } from "./EnterpriseRoleOutput.ts";
import { enterpriseRoleRun, enterpriseRoleThreadId, isDocumentationPath } from "./EnterpriseRun.ts";
import type * as Secrets from "./EnterpriseSecretService.ts";
import { taskCostFromProjections } from "./EnterpriseTaskCost.ts";
import type * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeArtifactInput = Schema.decodeUnknownEffect(EnterpriseCollectRoleArtifactInput);
const decodeRoleArtifact = Schema.decodeUnknownEffect(EnterpriseRoleArtifact);
const decodeDraftInput = Schema.decodeUnknownEffect(EnterpriseBuildPullRequestDraftInput);
const decodeEvidence = Schema.decodeUnknownEffect(PullRequestEvidence);
const decodeDraft = Schema.decodeUnknownEffect(EnterprisePullRequestDraft);
const decodeGateInput = Schema.decodeUnknownEffect(EnterpriseGateRoleInput);
const decodeHandoffInput = Schema.decodeUnknownEffect(EnterpriseCollectHandoffInput);
const decodeHandoff = Schema.decodeUnknownEffect(AgentHandoff);

const invalidInput = (cause: unknown) =>
  new EnterpriseRoleError({ reason: "invalid_input", cause });

export interface EnterpriseRoleEvidenceDeps {
  readonly git: Git.GitVcsDriver["Service"];
  readonly secrets: Secrets.EnterpriseSecretService["Service"];
  readonly workspace: Workspace.EnterpriseWorkspaceService["Service"];
  readonly threads: Threads.ThreadManagementService["Service"];
  readonly pricing: { readonly load: Effect.Effect<PriceTable | undefined> };
}

/**
 * Evidence is always derived from server-side state: V2 runs and checkpoints, Git objects and
 * gate artifacts. Nothing here trusts a commit, test result or path claimed by an agent or client.
 */
export const makeEnterpriseRoleEvidence = (deps: EnterpriseRoleEvidenceDeps) => {
  const { git, secrets, workspace, threads, pricing } = deps;

  const collectHandoff = Effect.fn("EnterpriseRoleService.collectHandoff")(function* (
    raw: EnterpriseCollectHandoffInput,
  ) {
    const input = yield* decodeHandoffInput(raw).pipe(Effect.mapError(invalidInput));
    const owned = yield* workspace.prepare({ ...input, spec: input.task });
    const identity = owned.branch.slice("enterprise/task-".length);
    const revision = input.revision ?? 0;
    if (input.role === "architect" && revision !== 0)
      return yield* new EnterpriseRoleError({ reason: "invalid_input" });
    const threadId = enterpriseRoleThreadId(identity, input.role, revision);
    if (!owned.boundThreadIds?.includes(threadId))
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const projection = yield* threads.getProjectThread({
      projectId: input.task.projectId,
      threadId,
    });
    if (projection.thread.worktreePath !== owned.worktreePath)
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const run = enterpriseRoleRun(projection, threadId);
    if (run === undefined || run.status !== "completed")
      return yield* new EnterpriseRoleError({ reason: "predecessor_incomplete" });
    const checkpoint = projection.checkpoints.find(
      (candidate) => candidate.id === run.checkpointId,
    );
    if (
      checkpoint === undefined ||
      checkpoint.status !== "ready" ||
      checkpoint.runId !== run.id ||
      checkpoint.threadId !== threadId
    )
      return yield* new EnterpriseRoleError({ reason: "predecessor_incomplete" });
    // V2 already persists the run and checkpoint ref. Resolve that immutable snapshot,
    // never HEAD (which may have moved), and never an agent-supplied commit or test claim.
    const commitSha = (yield* git.execute({
      operation: "EnterpriseRoleService.checkpoint",
      cwd: owned.worktreePath,
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${checkpoint.ref}^{commit}`,
      ],
    })).stdout.trim();
    // A local model is only routed documentation work; re-check what it actually changed.
    if (input.role === "coder" && isCodexLocalModel(run.modelSelection.model)) {
      const changed = yield* git.execute({
        operation: "EnterpriseRoleService.localScope",
        cwd: owned.worktreePath,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "diff",
          "--name-only",
          "-z",
          input.task.repoCommit,
          commitSha,
        ],
      });
      if (
        changed.stdout
          .split("\0")
          .filter(Boolean)
          .some((path) => !isDocumentationPath(path))
      )
        return yield* new EnterpriseRoleError({ reason: "invalid_output" });
    }
    yield* secrets.assertCommitClean({ repositoryRoot: owned.worktreePath, commitSha });
    return yield* decodeHandoff({
      taskId: input.task.taskId,
      threadId,
      runId: run.id,
      modelId: run.modelSelection,
      commitSha,
      inputArtifactIds: [],
      outputArtifactIds: [checkpoint.id],
      // The role's prose cannot establish a passing deterministic check.
      testEvidence: [],
      errors: [],
    });
  });

  const collectRoleArtifact = Effect.fn("EnterpriseRoleService.collectRoleArtifact")(function* (
    raw: EnterpriseCollectRoleArtifactInput,
  ) {
    const input = yield* decodeArtifactInput(raw).pipe(Effect.mapError(invalidInput));
    const handoff = yield* collectHandoff(input);
    const projection = yield* threads.getProjectThread({
      projectId: input.task.projectId,
      threadId: handoff.threadId,
    });
    const message = projection.messages.findLast(
      (candidate) =>
        candidate.role === "assistant" && candidate.runId === handoff.runId && !candidate.streaming,
    );
    if (message === undefined)
      return yield* new EnterpriseRoleError({ reason: "predecessor_incomplete" });
    let expectedCommit = input.task.repoCommit;
    let inputArtifactIds: ReadonlyArray<string> = [];
    if (input.role === "qa") {
      const coder = yield* collectHandoff({ ...input, role: "coder" });
      expectedCommit = coder.commitSha;
      inputArtifactIds = coder.outputArtifactIds;
    }
    // Compare file trees, not checkpoint commit IDs: capture may produce a new
    // commit for unchanged files. Both spec and QA must describe their intended snapshot.
    const owned = yield* workspace.prepare({ ...input, spec: input.task });
    const tree = (commit: string) =>
      git.execute({
        operation: "EnterpriseRoleService.reviewTree",
        cwd: owned.worktreePath,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${commit}^{tree}`,
        ],
        maxOutputBytes: 4096,
        outputMode: "error",
      });
    const trees = yield* Effect.all([tree(handoff.commitSha), tree(expectedCommit)], {
      concurrency: 2,
    });
    if (trees[0].stdout.trim() !== trees[1].stdout.trim())
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const output = yield* decodeEnterpriseRoleOutput({
      task: input.task,
      role: input.role,
      expectedCommit,
      text: message.text,
    });
    return yield* decodeRoleArtifact({
      artifactId: message.id,
      handoff: {
        ...handoff,
        inputArtifactIds,
        outputArtifactIds: [...handoff.outputArtifactIds, message.id],
      },
      output,
    });
  });

  const gateRole = Effect.fn("EnterpriseRoleService.gateRole")(function* (
    raw: EnterpriseGateRoleInput,
  ) {
    const input = yield* decodeGateInput(raw).pipe(Effect.mapError(invalidInput));
    const handoff = yield* collectHandoff(input);
    return yield* workspace.gateSnapshot({
      spec: input.task,
      repositoryRoot: input.repositoryRoot,
      workspacesRoot: input.workspacesRoot,
      handoff,
      checks: input.plan,
    });
  });

  const buildPullRequestDraft = Effect.fn("EnterpriseRoleService.buildPullRequestDraft")(function* (
    raw: EnterpriseBuildPullRequestDraftInput,
  ) {
    const input = yield* decodeDraftInput(raw).pipe(Effect.mapError(invalidInput));
    const handoff = yield* collectHandoff(input);
    const gate = yield* workspace.readSnapshotGate({
      spec: input.task,
      repositoryRoot: input.repositoryRoot,
      workspacesRoot: input.workspacesRoot,
      handoff,
      artifactId: input.artifactId,
    });
    // Cost is reported only when prices are configured and every started turn reported usage.
    const prices = yield* pricing.load;
    let amountCents: number | null = null;
    if (prices !== undefined) {
      const owned = yield* workspace.prepare({
        spec: input.task,
        repositoryRoot: input.repositoryRoot,
        workspacesRoot: input.workspacesRoot,
      });
      const projections = yield* Effect.forEach(owned.boundThreadIds ?? [], (threadId) =>
        threads.getProjectThread({ projectId: input.task.projectId, threadId }),
      );
      const cost = taskCostFromProjections(projections, prices);
      amountCents = cost.unpricedRecords === 0 ? cost.providerCents : null;
    }
    const checks = gate.handoff.testEvidence;
    const securityScan = checks.find((check) => check.kind === "security_scan");
    if (securityScan === undefined)
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const evidence = yield* decodeEvidence({
      taskId: input.task.taskId,
      diffSha: handoff.commitSha,
      tests: checks.filter((check) => check.kind !== "security_scan"),
      securityScan,
      cost: { currency: "USD", amountCents },
      provenance: {
        threadId: handoff.threadId,
        runId: handoff.runId,
        commitSha: handoff.commitSha,
        artifactIds: gate.handoff.outputArtifactIds,
      },
    });
    return yield* decodeDraft({
      evidence,
      body: renderEnterprisePullRequestDraft(input.task, evidence),
      approvalStatus: "not_evaluated",
    });
  });

  return { collectHandoff, collectRoleArtifact, gateRole, buildPullRequestDraft };
};
