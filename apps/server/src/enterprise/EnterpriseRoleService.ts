import {
  CommandId,
  EnterpriseGateAndContinueInput,
  EnterpriseGateAndContinueResult,
  EnterpriseLaunchRoleInput,
  EnterpriseReleaseWorkspaceInput,
  EnterpriseRoleError,
  EnterpriseSnapshotGateFailure,
  MessageId,
  ThreadId,
  type AgentHandoff,
  type EnterpriseBuildPullRequestDraftInput,
  type EnterpriseCollectHandoffInput,
  type EnterpriseCollectRoleArtifactInput,
  type EnterpriseGateRoleInput,
  type EnterprisePullRequestDraft,
  type EnterpriseRole,
  type EnterpriseRoleArtifact,
  type EnterpriseSnapshotGateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { makeEnterpriseCodexProbe } from "./EnterpriseCodexSupport.ts";
import { EnterprisePricing } from "./EnterprisePricing.ts";
import { makeEnterpriseRoleContext, renderEnterpriseRolePrompt } from "./EnterpriseRoleContext.ts";
import { makeEnterpriseRoleEvidence } from "./EnterpriseRoleEvidence.ts";
import { makeValidateRoleModel } from "./EnterpriseRoleModel.ts";
import { makeEnterpriseRoleRetry } from "./EnterpriseRoleRetry.ts";
import { enterpriseRoleThreadId, type EnterpriseRevision } from "./EnterpriseRun.ts";
import * as Secrets from "./EnterpriseSecretService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeContinueInput = Schema.decodeUnknownEffect(EnterpriseGateAndContinueInput);
const decodeContinueResult = Schema.decodeUnknownEffect(EnterpriseGateAndContinueResult);
const decodeReleaseInput = Schema.decodeUnknownEffect(EnterpriseReleaseWorkspaceInput);
const decodeInput = Schema.decodeUnknownEffect(EnterpriseLaunchRoleInput);

const isRoleError = Schema.is(EnterpriseRoleError);
/** Every failure leaves the service as a typed role error; unexpected causes become `launch_failed`. */
const asRoleError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      isRoleError(cause) ? cause : new EnterpriseRoleError({ reason: "launch_failed", cause }),
    ),
  );

export class EnterpriseRoleService extends Context.Service<
  EnterpriseRoleService,
  {
    /** Dispatches a bounded provider retry (at most two) for a failed role run on another model of the same backend. */
    readonly retry: (
      input: EnterpriseLaunchRoleInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId }, EnterpriseRoleError>;
    /** Gates the Coder checkpoint; on a recoverable check failure persists it and starts the next correction round. */
    readonly gateAndContinue: (
      input: EnterpriseGateAndContinueInput,
    ) => Effect.Effect<EnterpriseGateAndContinueResult, EnterpriseRoleError>;
    /** Returns the validated structured Architect spec or QA report from the persisted final V2 message. */
    readonly collectRoleArtifact: (
      input: EnterpriseCollectRoleArtifactInput,
    ) => Effect.Effect<EnterpriseRoleArtifact, EnterpriseRoleError>;
    /** Builds Proof-of-Work evidence and Markdown from a verified gate artifact. Never authorizes publish or merge. */
    readonly buildPullRequestDraft: (
      input: EnterpriseBuildPullRequestDraftInput,
    ) => Effect.Effect<EnterprisePullRequestDraft, EnterpriseRoleError>;
    /** Runs the deterministic gate on the completed Coder checkpoint resolved by the server, not the client. */
    readonly gateRole: (
      input: EnterpriseGateRoleInput,
    ) => Effect.Effect<EnterpriseSnapshotGateResult, EnterpriseRoleError>;
    /** Resolves the AgentHandoff for a completed role run from its ready V2 checkpoint. */
    readonly collectHandoff: (
      input: EnterpriseCollectHandoffInput,
    ) => Effect.Effect<AgentHandoff, EnterpriseRoleError>;
    /** Retires the task once every bound V2 thread is deleted, terminal and stopped. */
    readonly releaseWorkspace: (
      input: EnterpriseReleaseWorkspaceInput,
    ) => Effect.Effect<void, EnterpriseRoleError>;
    /** Launches (or idempotently resumes) a role thread with stable V2 command/message identity. */
    readonly launch: (
      input: EnterpriseLaunchRoleInput,
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly resumed: boolean },
      EnterpriseRoleError
    >;
  }
>()("t3/enterprise/EnterpriseRoleService") {}

/**
 * Composes the role pipeline over V2. Model checks, untrusted context and evidence live in
 * EnterpriseRoleModel / EnterpriseRoleContext / EnterpriseRoleEvidence; this file owns launch,
 * provider retry, gate continuation and release, which all dispatch through V2.
 */
const make = Effect.gen(function* () {
  const git = yield* Git.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const workspace = yield* Workspace.EnterpriseWorkspaceService;
  const threads = yield* Threads.ThreadManagementService;
  const launcher = yield* Launch.ThreadLaunchService;
  const validateModel = makeValidateRoleModel({
    codex: yield* makeEnterpriseCodexProbe,
    providers: yield* Providers.ProviderInstanceRegistry,
    runner: yield* ProcessRunner.ProcessRunner,
  });
  const evidence = makeEnterpriseRoleEvidence({
    git,
    secrets: yield* Secrets.EnterpriseSecretService,
    workspace,
    threads,
    pricing: yield* EnterprisePricing,
  });
  const context = makeEnterpriseRoleContext({ git, threads, evidence });

  const launch = Effect.fn("EnterpriseRoleService.launch")(function* (
    raw: EnterpriseLaunchRoleInput,
    gateFailure?: EnterpriseSnapshotGateFailure,
  ) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError((cause) => new EnterpriseRoleError({ reason: "invalid_input", cause })),
    );
    const revision = input.revision ?? 0;
    if (input.role === "architect" && revision !== 0)
      return yield* new EnterpriseRoleError({ reason: "invalid_input" });
    const requiredTool = input.role === "coder" ? "codex.workspace_write" : "codex.workspace_read";
    if (!input.task.approvedTools.includes(requiredTool))
      return yield* new EnterpriseRoleError({ reason: "tool_not_allowed" });
    const project = yield* projects.get(input.task.projectId);
    if (
      project._tag === "None" ||
      (yield* fs.realPath(project.value.workspaceRoot)) !==
        (yield* fs.realPath(input.repositoryRoot))
    )
      return yield* new EnterpriseRoleError({ reason: "project_mismatch" });
    yield* validateModel(input.modelSelection);
    const owned = yield* workspace.prepare({
      spec: input.task,
      repositoryRoot: input.repositoryRoot,
      workspacesRoot: input.workspacesRoot,
    });
    if (owned.retired) return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const identity = owned.branch.slice("enterprise/task-".length);
    const roleThreadId = (role: EnterpriseRole, round: EnterpriseRevision = revision) =>
      enterpriseRoleThreadId(identity, role, round);
    const threadId = roleThreadId(input.role);
    const messageId = MessageId.make(`${threadId}:initial`);
    const resolved = yield* context.resolve({
      input,
      owned,
      threadId,
      revision,
      roleThreadId,
      gateFailure,
    });
    const text = yield* renderEnterpriseRolePrompt(input, resolved);
    const existing = yield* threads
      .getProjectThread({ projectId: input.task.projectId, threadId })
      .pipe(
        Effect.catchTags({ ThreadManagementThreadNotFoundError: () => Effect.succeed(undefined) }),
      );
    if (existing !== undefined) {
      if (existing.thread.archivedAt !== null || existing.thread.deletedAt !== null)
        return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
      const original = existing.messages.find((message) => message.id === messageId);
      if (original !== undefined && original.text !== text)
        return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
      if (existing.thread.worktreePath !== owned.worktreePath)
        return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    }
    // Persist the resource association before dispatch. Failed/ambiguous launches keep
    // cleanup blocked; V2 receipts/outbox own execution and retries, not this manifest.
    yield* workspace.bindThread({
      spec: input.task,
      repositoryRoot: input.repositoryRoot,
      workspacesRoot: input.workspacesRoot,
      threadId,
    });
    const result = yield* launcher.launch({
      commandId: CommandId.make(`${threadId}:launch`),
      threadId,
      projectId: input.task.projectId,
      title: `${input.task.taskId} / ${input.role}${revision === 0 ? "" : ` / correction ${revision}`}`,
      modelSelection: input.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: {
        type: "existing_worktree",
        worktreePath: owned.worktreePath,
        branch: owned.branch,
      },
      initialMessage: { messageId, text, attachments: [] },
      createdBy: "user",
      creationSource: "server",
    });
    return { threadId: result.threadId, resumed: result.resumed };
  });
  const retry = makeEnterpriseRoleRetry({ git, workspace, threads, evidence, validateModel });
  const gateAndContinue = Effect.fn("EnterpriseRoleService.gateAndContinue")(function* (
    raw: EnterpriseGateAndContinueInput,
  ) {
    const input = yield* decodeContinueInput(raw).pipe(
      Effect.mapError((cause) => new EnterpriseRoleError({ reason: "invalid_input", cause })),
    );
    const handoff = yield* evidence.collectHandoff(input);
    const params = {
      spec: input.task,
      repositoryRoot: input.repositoryRoot,
      workspacesRoot: input.workspacesRoot,
      handoff,
      checks: input.plan,
    };
    // A persisted failure is the recovery point if the process stopped before launch.
    // Reusing it also keeps the correction prompt stable on duplicate RPCs.
    let failure = yield* workspace.readSnapshotFailure(params);
    if (failure === undefined) {
      const gate = yield* workspace.gateSnapshot(params).pipe(Effect.result);
      if (gate._tag === "Success")
        return yield* decodeContinueResult({ status: "passed", gate: gate.success });
      if (
        gate.failure._tag !== "EnterpriseWorkspaceRejected" ||
        gate.failure.reason !== "check_failed" ||
        gate.failure.artifactId === undefined
      )
        return yield* Effect.fail(gate.failure);
      failure = yield* workspace.readSnapshotFailure(params);
      if (failure === undefined)
        return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    }
    const revision = input.revision ?? 0;
    if (revision === 2) return yield* decodeContinueResult({ status: "blocked", failure });
    const started = yield* launch({ ...input, revision: revision === 0 ? 1 : 2 }, failure);
    return yield* decodeContinueResult({ status: "fix_started", failure, launch: started });
  });
  const releaseWorkspace = Effect.fn("EnterpriseRoleService.releaseWorkspace")(function* (
    raw: EnterpriseReleaseWorkspaceInput,
  ) {
    const input = yield* decodeReleaseInput(raw);
    const owned = yield* workspace.prepare({ ...input, spec: input.task });
    const threadIds = owned.boundThreadIds ?? [];
    for (const threadId of threadIds) {
      const projection = yield* threads.getThreadProjection(threadId);
      if (
        projection.thread.projectId !== input.task.projectId ||
        projection.thread.worktreePath !== owned.worktreePath
      )
        return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
      if (
        projection.thread.deletedAt === null ||
        projection.runs.some((run) => !Threads.isTerminalRunStatus(run.status)) ||
        projection.providerSessions.some((session) => session.status !== "stopped")
      )
        return yield* new EnterpriseRoleError({ reason: "workspace_in_use" });
    }
    yield* workspace.releaseBindings({ ...input, spec: input.task, threadIds });
  });
  return EnterpriseRoleService.of({
    retry: (input) => asRoleError(retry(input)),
    gateAndContinue: (input) => asRoleError(gateAndContinue(input)),
    collectRoleArtifact: (input) => asRoleError(evidence.collectRoleArtifact(input)),
    buildPullRequestDraft: (input) => asRoleError(evidence.buildPullRequestDraft(input)),
    gateRole: (input) => asRoleError(evidence.gateRole(input)),
    collectHandoff: (input) => asRoleError(evidence.collectHandoff(input)),
    releaseWorkspace: (input) => asRoleError(releaseWorkspace(input)),
    launch: (input) => asRoleError(launch(input)),
  });
});
export const layer = Layer.effect(EnterpriseRoleService, make).pipe(
  Layer.provide(Layer.mergeAll(Git.layer, Secrets.layer.pipe(Layer.provide(Git.layer)))),
);
