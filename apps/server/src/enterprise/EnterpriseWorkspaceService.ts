import {
  TaskSpec,
  EnterpriseWorkflowAutomationRecord,
  ThreadId,
  AgentHandoff,
  EnterpriseGatePlan,
  EnterpriseSnapshotGateResult,
  EnterpriseSnapshotGateFailure,
  EnterpriseBuildPullRequestDraftInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ProcessRunner from "../processRunner.ts";
import { enterpriseTaskKey, enterpriseWorkflowKey } from "./EnterpriseWorkflowConfiguration.ts";
import { enterpriseSecretKinds, redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";
import * as Secrets from "./EnterpriseSecretService.ts";
import { EnterpriseTenancy } from "./EnterpriseTenancy.ts";
import * as Sandbox from "./EnterpriseSandboxService.ts";

const encodeAutomation = Schema.encodeEffect(
  Schema.fromJsonString(EnterpriseWorkflowAutomationRecord),
);
const decodeAutomation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EnterpriseWorkflowAutomationRecord),
);
const decodeAutomationValue = Schema.decodeUnknownEffect(EnterpriseWorkflowAutomationRecord);
const Ownership = Schema.Struct({
  version: Schema.Literal(1),
  spec: TaskSpec,
  repositoryRoot: Schema.String,
  worktreePath: Schema.String,
  branch: Schema.String,
  createdAt: Schema.Number,
  status: Schema.Literals(["allocated", "cleaned"]),
  boundThreadIds: Schema.optionalKey(Schema.Array(ThreadId)),
  retired: Schema.optionalKey(Schema.Boolean),
  workflowKey: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
});
const decodeFailure = Schema.decodeUnknownEffect(EnterpriseSnapshotGateFailure);
const decodeHandoff = Schema.decodeUnknownEffect(AgentHandoff);
const decodePlan = Schema.decodeUnknownEffect(EnterpriseGatePlan);
const decodeSnapshotResult = Schema.decodeUnknownEffect(EnterpriseSnapshotGateResult);
const decodeOwnership = Schema.decodeUnknownEffect(Schema.fromJsonString(Ownership));
const encodeOwnership = Schema.encodeEffect(Schema.fromJsonString(Ownership));
const decodeSpecFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskSpec));
const decodeCheckFile = Schema.decodeUnknownEffect(Schema.fromJsonString(Sandbox.EnterpriseCheck));
const decodeGatePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(EnterpriseGatePlan));
const CheckArtifact = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["test", "lint", "typecheck", "security_scan"]),
  status: Schema.Literal("passed"),
  commitSha: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
});
const encodeGateArtifact = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      task: TaskSpec,
      commitSha: Schema.String,
      checks: Schema.Array(CheckArtifact),
    }),
  ),
);
const SnapshotArtifact = Schema.Struct({
  version: Schema.Literal(1),
  task: TaskSpec,
  result: EnterpriseSnapshotGateResult,
  plan: EnterpriseGatePlan,
  checks: Schema.Array(CheckArtifact),
});
const encodeSnapshotArtifact = Schema.encodeEffect(Schema.fromJsonString(SnapshotArtifact));
const decodeSnapshotArtifact = Schema.decodeUnknownEffect(Schema.fromJsonString(SnapshotArtifact));
const FailureArtifact = Schema.Struct({
  version: Schema.Literal(1),
  task: TaskSpec,
  result: EnterpriseSnapshotGateFailure,
  plan: EnterpriseGatePlan,
});
const encodeFailureArtifact = Schema.encodeEffect(Schema.fromJsonString(FailureArtifact));
const decodeFailureArtifact = Schema.decodeUnknownEffect(Schema.fromJsonString(FailureArtifact));
const encodeFailureKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ handoff: AgentHandoff, plan: EnterpriseGatePlan })),
);
const encodeFailurePlan = Schema.encodeEffect(Schema.fromJsonString(EnterpriseGatePlan));
const decodeArtifactId = Schema.decodeUnknownEffect(
  EnterpriseBuildPullRequestDraftInput.fields.artifactId,
);
const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(AgentHandoff));
const isSecretPath = (name: string) =>
  /(^|\/)\.env(?:\.|$)|(^|\/)(?:id_rsa|id_ed25519|credentials)$|\.(?:pem|key)$/i.test(name);
const encodeCheckArtifact = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      kind: Schema.Literals(["test", "lint", "typecheck", "security_scan"]),
      status: Schema.Literal("passed"),
      commitSha: Schema.String,
      stdout: Schema.String,
      stderr: Schema.String,
    }),
  ),
);
const encodeSpec = Schema.encodeEffect(Schema.fromJsonString(TaskSpec));
export class EnterpriseWorkspaceRejected extends Schema.TaggedError<EnterpriseWorkspaceRejected>()(
  "EnterpriseWorkspaceRejected",
  {
    artifactId: Schema.optional(EnterpriseSnapshotGateFailure.fields.artifactId),
    reason: Schema.Literals([
      "root_inside_repository",
      "busy",
      "ownership_mismatch",
      "allocation_incomplete",
      "dirty_worktree",
      "new_commits",
      "checkout_mismatch",
      "checkout_filters",
      "secret_files",
      "sandbox_unavailable",
      "check_failed",
      "check_timed_out",
      "tool_not_allowed",
      "tenant_not_allowed",
    ]),
  },
) {
  override get message(): string {
    return `Enterprise workspace operation rejected: ${this.reason}.`;
  }
}
export class EnterpriseWorkspaceError extends Schema.TaggedError<EnterpriseWorkspaceError>()(
  "EnterpriseWorkspaceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Enterprise workspace operation failed.";
  }
}
export class EnterpriseWorkspaceService extends Context.Service<
  EnterpriseWorkspaceService,
  {
    /** Reads the persisted gate-failure record for this handoff and plan; validates task/run/commit/plan before use. */
    readonly readSnapshotFailure: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly handoff: AgentHandoff;
      readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
    }) => Effect.Effect<
      EnterpriseSnapshotGateFailure | undefined,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Reads a passing `gate-*.json` artifact and checks it still matches the task, V2 handoff and checkpoint commit. */
    readonly readSnapshotGate: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly handoff: AgentHandoff;
      readonly artifactId: string;
    }) => Effect.Effect<
      EnterpriseSnapshotGateResult,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Runs the check plan on a detached snapshot of the handoff commit under the ownership lock; never touches the agent checkout. */
    readonly gateSnapshot: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly handoff: AgentHandoff;
      readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
    }) => Effect.Effect<
      EnterpriseSnapshotGateResult,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Creates or reuses the owned task worktree. Retries reuse the immutable manifest and never adopt an orphan checkout. */
    readonly prepare: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Removes a clean, unbound task worktree. Refuses held locks, dirty/ignored files and new commits; never force-removes. */
    readonly cleanup: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Retires V2 thread bindings once those threads are deleted, terminal and their sessions stopped. */
    readonly releaseBindings: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly threadIds: ReadonlyArray<ThreadId>;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Reads `workflow-automation.json` beside the ownership manifest (size, symlink and identity checked). */
    readonly readAutomation: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      EnterpriseWorkflowAutomationRecord | undefined,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Atomically persists the automation record under the operation lock. */
    readonly writeAutomation: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly record: EnterpriseWorkflowAutomationRecord;
    }) => Effect.Effect<void, EnterpriseWorkspaceRejected | EnterpriseWorkspaceError>;
    /** Binds the workflow configuration digest; a later call with a different digest is rejected. */
    readonly bindWorkflow: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly key: string;
    }) => Effect.Effect<void, EnterpriseWorkspaceRejected | EnterpriseWorkspaceError>;
    /** Records a V2 role thread binding before launch so cleanup stays closed if launch outcome is unknown. */
    readonly bindThread: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** CLI entry: `prepare` with a TaskSpec read from disk. */
    readonly prepareFile: (input: {
      readonly specPath: string;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** CLI entry: `cleanup` with a TaskSpec read from disk. */
    readonly cleanupFile: (input: {
      readonly specPath: string;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** CLI entry: runs a four-check gate plan read from disk against the task checkout. */
    readonly gateFile: (input: {
      readonly specPath: string;
      readonly planPath: string;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** CLI entry: runs one sandboxed check read from disk against the task checkout. */
    readonly checkFile: (input: {
      readonly specPath: string;
      readonly checkPath: string;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      typeof Ownership.Type,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
  }
>()("t3/enterprise/EnterpriseWorkspaceService") {}

const isWorkspaceRejected = Schema.is(EnterpriseWorkspaceRejected);
const isWorkspaceError = Schema.is(EnterpriseWorkspaceError);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const git = yield* Git.GitVcsDriver;
  const sandbox = yield* Sandbox.EnterpriseSandboxService;
  const secrets = yield* Secrets.EnterpriseSecretService;
  const tenancy = yield* EnterpriseTenancy;
  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: "EnterpriseWorkspaceService.git",
      cwd,
      args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    });
  const failureId = (handoff: AgentHandoff, plan: typeof EnterpriseGatePlan.Type) =>
    Effect.gen(function* () {
      const digest = yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(yield* encodeFailureKey({ handoff, plan })),
      );
      return `gate-failure-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
    });
  const safePlan = (plan: typeof EnterpriseGatePlan.Type) =>
    plan.map((check) => ({ ...check, args: check.args.map(redactEnterpriseSecrets) }));
  /**
   * Codex 0.162.1 fails to start its Linux sandbox (`bwrap: Can't create file ...: Is a directory`)
   * when a denied path (`.codex`, `.agents`) is missing from the writable checkout. Empty directories
   * are invisible to Git, so they do not dirty the worktree.
   */
  const ensureAgentProtectedDirectories = (worktreePath: string) =>
    Effect.forEach(
      [".codex", ".agents"],
      (name) => {
        const target = path.join(worktreePath, name);
        return fs
          .exists(target)
          .pipe(Effect.flatMap((exists) => (exists ? Effect.void : fs.makeDirectory(target))));
      },
      { discard: true },
    );
  const mutate = Effect.fn("EnterpriseWorkspaceService.mutate")(function* (
    input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    },
    operation:
      | "prepare"
      | "cleanup"
      | Sandbox.EnterpriseCheck
      | ReadonlyArray<Sandbox.EnterpriseCheck>
      | { readonly type: "read_automation" }
      | { readonly type: "write_automation"; readonly record: EnterpriseWorkflowAutomationRecord }
      | { readonly type: "bind_workflow"; readonly key: string }
      | { readonly type: "bind_v2"; readonly threadId: ThreadId }
      | { readonly type: "release_v2"; readonly threadIds: ReadonlyArray<ThreadId> }
      | {
          readonly type: "snapshot_gate";
          readonly handoff: AgentHandoff;
          readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
        }
      | {
          readonly type: "read_snapshot_failure";
          readonly handoff: AgentHandoff;
          readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
        }
      | {
          readonly type: "read_snapshot_gate";
          readonly handoff: AgentHandoff;
          readonly artifactId: string;
        },
  ) {
    // Checked before any filesystem effect: an unlisted tenant cannot create or read task state.
    yield* tenancy
      .authorize(input.spec.tenantId)
      .pipe(
        Effect.mapError(() => new EnterpriseWorkspaceRejected({ reason: "tenant_not_allowed" })),
      );
    const repositoryRoot = yield* fs.realPath(input.repositoryRoot);
    yield* fs.makeDirectory(input.workspacesRoot, { recursive: true });
    const root = yield* fs.realPath(input.workspacesRoot);
    const relative = path.relative(repositoryRoot, root);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    )
      return yield* new EnterpriseWorkspaceRejected({ reason: "root_inside_repository" });
    const id = yield* enterpriseTaskKey(input.spec);
    const controlDir = path.join(root, id);
    yield* fs.makeDirectory(controlDir, { recursive: true });
    if ((yield* fs.realPath(controlDir)) !== controlDir)
      return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
    const lock = path.join(controlDir, "operation.lock");
    return yield* Effect.acquireUseRelease(
      fs.makeDirectory(lock).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "AlreadyExists"
              ? Effect.fail(new EnterpriseWorkspaceRejected({ reason: "busy" }))
              : Effect.fail(error),
        }),
      ),
      () =>
        Effect.gen(function* () {
          const manifest = path.join(controlDir, "ownership.json");
          const worktreePath = path.join(controlDir, "checkout");
          const branch = `enterprise/task-${id}`;
          // Checkout filters and repository hooks are executable host-side configuration.
          const filters = yield* git.execute({
            operation: "EnterpriseWorkspaceService.filters",
            cwd: repositoryRoot,
            args: ["config", "--get-regexp", "^filter\\..*\\.(process|smudge|clean)$"],
            allowNonZeroExit: true,
          });
          if (filters.exitCode === 0)
            return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_filters" });
          yield* secrets.assertCommitClean({ repositoryRoot, commitSha: input.spec.repoCommit });
          const exists = yield* fs.exists(manifest);
          let ownership: typeof Ownership.Type | undefined;
          if (exists) {
            if ((yield* fs.realPath(manifest)) !== manifest)
              return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
            ownership = yield* decodeOwnership(yield* fs.readFileString(manifest));
            if (
              ownership.repositoryRoot !== repositoryRoot ||
              ownership.worktreePath !== worktreePath ||
              ownership.branch !== branch ||
              (yield* encodeSpec(ownership.spec)) !== (yield* encodeSpec(input.spec))
            )
              return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
            if (ownership.status === "cleaned") {
              if (operation === "cleanup") return ownership;
              return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
            }
            if ((yield* fs.realPath(worktreePath)) !== worktreePath)
              return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_mismatch" });
            const actualBranch = (yield* runGit(worktreePath, [
              "symbolic-ref",
              "--short",
              "HEAD",
            ])).stdout.trim();
            const commonDir = (yield* runGit(worktreePath, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])).stdout.trim();
            const repositoryCommonDir = (yield* runGit(repositoryRoot, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ])).stdout.trim();
            if (actualBranch !== branch || commonDir !== repositoryCommonDir)
              return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_mismatch" });
            if (operation === "prepare") {
              yield* ensureAgentProtectedDirectories(worktreePath);
              return ownership;
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              (operation.type === "read_automation" || operation.type === "write_automation")
            ) {
              const file = path.join(controlDir, "workflow-automation.json");
              let record: EnterpriseWorkflowAutomationRecord;
              if (operation.type === "read_automation") {
                if (!(yield* fs.exists(file))) return { ...ownership, automation: undefined };
                if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).size > 1_048_576)
                  return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
                const contents = yield* fs.readFileString(file);
                if (new TextEncoder().encode(contents).length > 1_048_576)
                  return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
                record = yield* decodeAutomation(contents);
              } else record = operation.record;
              const contents = yield* encodeAutomation(record);
              if (
                (yield* encodeSpec(record.input.task)) !== (yield* encodeSpec(input.spec)) ||
                (yield* fs.realPath(record.input.repositoryRoot)) !== repositoryRoot ||
                (yield* fs.realPath(record.input.workspacesRoot)) !== root ||
                (yield* enterpriseWorkflowKey(record.input)) !== ownership.workflowKey ||
                (ownership.retired && record.enabled) ||
                new TextEncoder().encode(contents).length > 1_048_576 ||
                enterpriseSecretKinds(contents).length > 0
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              if (operation.type === "write_automation") {
                if ((yield* fs.exists(file)) && (yield* fs.realPath(file)) !== file)
                  return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
                yield* writeFileStringAtomically({ filePath: file, contents }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                );
              }
              return { ...ownership, automation: record };
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              operation.type === "bind_workflow"
            ) {
              if (
                ownership.retired ||
                (ownership.workflowKey === undefined &&
                  (ownership.boundThreadIds?.length ?? 0) > 0) ||
                !/^[a-f0-9]{64}$/.test(operation.key) ||
                (ownership.workflowKey !== undefined && ownership.workflowKey !== operation.key)
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              if (ownership.workflowKey === undefined) {
                ownership = { ...ownership, workflowKey: operation.key };
                yield* writeFileStringAtomically({
                  filePath: manifest,
                  contents: yield* encodeOwnership(ownership),
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                );
              }
              return ownership;
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              operation.type === "bind_v2"
            ) {
              if (ownership.retired)
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              ownership = {
                ...ownership,
                boundThreadIds: [
                  ...new Set([...(ownership.boundThreadIds ?? []), operation.threadId]),
                ],
              };
              yield* writeFileStringAtomically({
                filePath: manifest,
                contents: yield* encodeOwnership(ownership),
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
              return ownership;
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              operation.type === "release_v2"
            ) {
              const bound = ownership.boundThreadIds ?? [];
              if (
                bound.length !== new Set(operation.threadIds).size ||
                bound.some((id) => !operation.threadIds.includes(id))
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "busy" });
              ownership = { ...ownership, boundThreadIds: [], retired: true };
              yield* writeFileStringAtomically({
                filePath: manifest,
                contents: yield* encodeOwnership(ownership),
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
              return ownership;
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              operation.type === "read_snapshot_failure"
            ) {
              const handoff = yield* decodeHandoff(operation.handoff);
              const checks = yield* decodePlan(operation.checks);
              if (
                !ownership.boundThreadIds?.includes(handoff.threadId) ||
                handoff.taskId !== input.spec.taskId
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const artifactId = yield* failureId(handoff, checks);
              const artifactPath = path.join(controlDir, artifactId);
              if (!(yield* fs.exists(artifactPath))) return { ...ownership, failure: undefined };
              if (
                (yield* fs.realPath(artifactPath)) !== artifactPath ||
                (yield* fs.stat(artifactPath)).size > 1_048_576
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const contents = yield* fs.readFileString(artifactPath);
              if (new TextEncoder().encode(contents).length > 1_048_576)
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const artifact = yield* decodeFailureArtifact(contents);
              if (
                artifact.result.artifactId !== artifactId ||
                (yield* encodeSpec(artifact.task)) !== (yield* encodeSpec(input.spec)) ||
                (yield* encodeHandoff(artifact.result.handoff)) !==
                  (yield* encodeHandoff(handoff)) ||
                (yield* encodeFailurePlan(artifact.plan)) !==
                  (yield* encodeFailurePlan(safePlan(checks))) ||
                !checks.some(
                  (check) =>
                    check.name === artifact.result.failedCheck.name &&
                    check.kind === artifact.result.failedCheck.kind,
                ) ||
                checks.some((check) => !input.spec.approvedTools.includes(check.tool))
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              return { ...ownership, failure: artifact.result };
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              operation.type === "read_snapshot_gate"
            ) {
              const artifactId = yield* decodeArtifactId(operation.artifactId);
              const handoff = yield* decodeHandoff(operation.handoff);
              if (
                !ownership.boundThreadIds?.includes(handoff.threadId) ||
                handoff.taskId !== input.spec.taskId
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const artifactPath = path.join(controlDir, artifactId);
              if (
                (yield* fs.realPath(artifactPath)) !== artifactPath ||
                (yield* fs.stat(artifactPath)).size > 1_048_576
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const contents = yield* fs.readFileString(artifactPath);
              if (new TextEncoder().encode(contents).length > 1_048_576)
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const artifact = yield* decodeSnapshotArtifact(contents);
              const recorded = artifact.result.handoff;
              const originalHandoff = {
                ...recorded,
                testEvidence: [],
                outputArtifactIds: recorded.outputArtifactIds.filter((id) => id !== artifactId),
              };
              if (
                artifact.result.artifactId !== artifactId ||
                (yield* encodeSpec(artifact.task)) !== (yield* encodeSpec(input.spec)) ||
                (yield* encodeHandoff(originalHandoff)) !== (yield* encodeHandoff(handoff)) ||
                artifact.checks.length !== recorded.testEvidence.length ||
                artifact.plan.length !== artifact.checks.length ||
                artifact.checks.some((check, index) => {
                  const evidence = recorded.testEvidence[index]!;
                  const command = artifact.plan[index]!;
                  return (
                    check.commitSha !== handoff.commitSha ||
                    check.name !== evidence.name ||
                    check.kind !== evidence.kind ||
                    command.name !== check.name ||
                    command.kind !== check.kind ||
                    !input.spec.approvedTools.includes(command.tool)
                  );
                })
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              return { ...ownership, gate: artifact.result };
            }
            if (
              typeof operation !== "string" &&
              "type" in operation &&
              operation.type === "snapshot_gate"
            ) {
              const handoff = yield* decodeHandoff(operation.handoff);
              const checks = yield* decodePlan(operation.checks);
              if (
                handoff.taskId !== input.spec.taskId ||
                !ownership.boundThreadIds?.includes(handoff.threadId)
              )
                return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
              const commitSha = (yield* runGit(repositoryRoot, [
                "rev-parse",
                "--verify",
                "--end-of-options",
                `${handoff.commitSha}^{commit}`,
              ])).stdout.trim();
              if (commitSha !== handoff.commitSha)
                return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_mismatch" });
              yield* secrets.assertCommitClean({ repositoryRoot, commitSha });
              const tracked = (yield* runGit(repositoryRoot, [
                "ls-tree",
                "-r",
                "--name-only",
                "-z",
                commitSha,
              ])).stdout.split("\0");
              if (tracked.some(isSecretPath))
                return yield* new EnterpriseWorkspaceRejected({ reason: "secret_files" });
              // The agent checkout can keep changing. Checks get a separate detached
              // snapshot; the fixed path and shared operation lock refuse orphan adoption.
              const snapshotPath = path.join(controlDir, "snapshot-checkout");
              if (yield* fs.exists(snapshotPath))
                return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
              let failedCheck: EnterpriseSnapshotGateFailure["failedCheck"] | undefined;
              const artifacts = yield* Effect.acquireUseRelease(
                runGit(repositoryRoot, ["worktree", "add", "--detach", snapshotPath, commitSha]),
                () =>
                  Effect.gen(function* () {
                    const artifacts: Array<typeof CheckArtifact.Type> = [];
                    for (const check of checks) {
                      const attempt = yield* sandbox
                        .run({
                          spec: input.spec,
                          worktreePath: snapshotPath,
                          check,
                        })
                        .pipe(Effect.result);
                      if (
                        attempt._tag === "Failure" &&
                        !(
                          attempt.failure._tag === "EnterpriseCheckRejected" &&
                          attempt.failure.reason === "check_failed"
                        )
                      )
                        return yield* Effect.fail(attempt.failure);
                      const status = (yield* runGit(snapshotPath, [
                        "status",
                        "--porcelain",
                        "--untracked-files=all",
                        "--ignored",
                      ])).stdout;
                      const head = (yield* runGit(snapshotPath, [
                        "rev-parse",
                        "HEAD",
                      ])).stdout.trim();
                      if (status.trim() || head !== commitSha)
                        return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
                      if (attempt._tag === "Failure") {
                        failedCheck = { name: check.name, kind: check.kind };
                        break;
                      }
                      const output = attempt.success;
                      artifacts.push({
                        name: check.name,
                        kind: check.kind,
                        status: "passed",
                        commitSha,
                        stdout: redactEnterpriseSecrets(output.stdout),
                        stderr: redactEnterpriseSecrets(output.stderr),
                      });
                    }
                    return artifacts;
                  }),
                // Keep dirty/ignored output for review. Git alone may ignore ignored
                // files when deciding whether removal is safe, so inspect them explicitly.
                () =>
                  Effect.gen(function* () {
                    const status = (yield* runGit(snapshotPath, [
                      "status",
                      "--porcelain",
                      "--untracked-files=all",
                      "--ignored",
                    ])).stdout;
                    const head = (yield* runGit(snapshotPath, ["rev-parse", "HEAD"])).stdout.trim();
                    if (!status.trim() && head === commitSha)
                      yield* git.removeWorktree({
                        cwd: repositoryRoot,
                        path: snapshotPath,
                        force: false,
                      });
                  }).pipe(Effect.ignore),
              );
              if (yield* fs.exists(snapshotPath))
                return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
              if (failedCheck !== undefined) {
                const artifactId = yield* failureId(handoff, checks);
                const contents = yield* encodeFailureArtifact({
                  version: 1,
                  task: input.spec,
                  result: { artifactId, handoff, failedCheck, reason: "check_failed" },
                  plan: safePlan(checks),
                });
                if (new TextEncoder().encode(contents).length > 1_048_576)
                  return yield* new EnterpriseWorkspaceRejected({ reason: "check_failed" });
                if (!(yield* fs.exists(path.join(controlDir, artifactId))))
                  yield* writeFileStringAtomically({
                    filePath: path.join(controlDir, artifactId),
                    contents,
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, fs),
                    Effect.provideService(Path.Path, path),
                  );
                return yield* new EnterpriseWorkspaceRejected({
                  reason: "check_failed",
                  artifactId,
                });
              }
              const artifactId = `gate-${yield* crypto.randomUUIDv4}.json`;
              const result = yield* decodeSnapshotResult({
                artifactId,
                handoff: {
                  ...handoff,
                  outputArtifactIds: [...handoff.outputArtifactIds, artifactId],
                  testEvidence: artifacts.map((check) => ({
                    name: check.name,
                    kind: check.kind,
                    status: check.status,
                    commitSha,
                    artifactIds: [artifactId],
                  })),
                },
              });
              const contents = yield* encodeSnapshotArtifact({
                version: 1,
                task: input.spec,
                result,
                plan: checks.map((check) => ({
                  ...check,
                  args: check.args.map(redactEnterpriseSecrets),
                })),
                checks: artifacts,
              });
              if (new TextEncoder().encode(contents).length > 1_048_576)
                return yield* new EnterpriseWorkspaceRejected({ reason: "check_failed" });
              yield* writeFileStringAtomically({
                filePath: path.join(controlDir, artifactId),
                contents,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
              return { ...ownership, gate: result };
            }
            if (operation === "cleanup" && (ownership.boundThreadIds?.length ?? 0) > 0)
              return yield* new EnterpriseWorkspaceRejected({ reason: "busy" });
            if (typeof operation !== "string") {
              const head = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
              yield* secrets.assertCommitClean({ repositoryRoot: worktreePath, commitSha: head });
              const before = (yield* runGit(worktreePath, [
                "status",
                "--porcelain",
                "--untracked-files=all",
              ])).stdout;
              if (before.trim())
                return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
              const checks: ReadonlyArray<Sandbox.EnterpriseCheck> = Array.isArray(operation)
                ? operation
                : [operation as Sandbox.EnterpriseCheck];
              const artifacts: Array<typeof CheckArtifact.Type> = [];
              for (const check of checks) {
                const output = yield* sandbox.run({ spec: input.spec, worktreePath, check });
                const after = (yield* runGit(worktreePath, [
                  "status",
                  "--porcelain",
                  "--untracked-files=all",
                ])).stdout;
                const afterHead = (yield* runGit(worktreePath, [
                  "rev-parse",
                  "HEAD",
                ])).stdout.trim();
                if (after.trim() || afterHead !== head)
                  return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
                artifacts.push({
                  name: check.name,
                  kind: check.kind,
                  status: "passed",
                  commitSha: head,
                  stdout: redactEnterpriseSecrets(output.stdout),
                  stderr: redactEnterpriseSecrets(output.stderr),
                });
              }
              const batch = Array.isArray(operation);
              const artifactPath = path.join(
                controlDir,
                `${batch ? "gate" : "check"}-${yield* crypto.randomUUIDv4}.json`,
              );
              yield* writeFileStringAtomically({
                filePath: artifactPath,
                contents: batch
                  ? yield* encodeGateArtifact({
                      task: input.spec,
                      commitSha: head,
                      checks: artifacts,
                    })
                  : yield* encodeCheckArtifact(artifacts[0]!),
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              );
              return ownership;
            }
            const status = (yield* runGit(worktreePath, [
              "status",
              "--porcelain",
              "--untracked-files=all",
              "--ignored",
            ])).stdout;
            if (status.trim())
              return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
            const head = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
            if (head !== input.spec.repoCommit)
              return yield* new EnterpriseWorkspaceRejected({ reason: "new_commits" });
            yield* git.removeWorktree({ cwd: repositoryRoot, path: worktreePath, force: false });
            ownership = { ...ownership, status: "cleaned" };
            yield* writeFileStringAtomically({
              filePath: manifest,
              contents: yield* encodeOwnership(ownership),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
            return ownership;
          }
          if (operation !== "prepare" || (yield* fs.exists(worktreePath)))
            return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
          const tracked = (yield* runGit(repositoryRoot, [
            "ls-tree",
            "-r",
            "--name-only",
            "-z",
            input.spec.repoCommit,
          ])).stdout.split("\0");
          if (tracked.some(isSecretPath))
            return yield* new EnterpriseWorkspaceRejected({ reason: "secret_files" });
          yield* git.createWorktree(
            {
              cwd: repositoryRoot,
              refName: input.spec.repoCommit,
              newRefName: branch,
              path: worktreePath,
            },
            { disableHooks: true, submodules: "none" },
          );
          yield* ensureAgentProtectedDirectories(worktreePath);
          ownership = {
            version: 1,
            spec: input.spec,
            repositoryRoot,
            worktreePath,
            branch,
            createdAt: DateTime.toEpochMillis(yield* DateTime.now),
            status: "allocated",
          };
          yield* writeFileStringAtomically({
            filePath: manifest,
            contents: yield* encodeOwnership(ownership),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          return ownership;
        }),
      () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
    );
  });
  const invoke = (
    input: Parameters<typeof mutate>[0],
    operation:
      | "prepare"
      | "cleanup"
      | Sandbox.EnterpriseCheck
      | ReadonlyArray<Sandbox.EnterpriseCheck>
      | { readonly type: "read_automation" }
      | { readonly type: "write_automation"; readonly record: EnterpriseWorkflowAutomationRecord }
      | { readonly type: "bind_workflow"; readonly key: string }
      | { readonly type: "bind_v2"; readonly threadId: ThreadId }
      | { readonly type: "release_v2"; readonly threadIds: ReadonlyArray<ThreadId> }
      | {
          readonly type: "snapshot_gate";
          readonly handoff: AgentHandoff;
          readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
        }
      | {
          readonly type: "read_snapshot_failure";
          readonly handoff: AgentHandoff;
          readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
        }
      | {
          readonly type: "read_snapshot_gate";
          readonly handoff: AgentHandoff;
          readonly artifactId: string;
        },
  ) =>
    mutate(input, operation).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) =>
        cause._tag === "EnterpriseWorkspaceRejected"
          ? cause
          : cause._tag === "EnterpriseSecretsDetected" || cause._tag === "EnterpriseSecretScanError"
            ? new EnterpriseWorkspaceRejected({ reason: "secret_files" })
            : cause._tag === "EnterpriseSandboxUnavailable"
              ? new EnterpriseWorkspaceRejected({ reason: "sandbox_unavailable" })
              : cause._tag === "EnterpriseCheckRejected"
                ? new EnterpriseWorkspaceRejected({ reason: cause.reason })
                : new EnterpriseWorkspaceError({ cause }),
      ),
    );
  const wrap = (cause: unknown) =>
    isWorkspaceRejected(cause) || isWorkspaceError(cause)
      ? cause
      : new EnterpriseWorkspaceError({ cause });
  const readFile = (filePath: string) =>
    Effect.gen(function* () {
      const info = yield* fs.stat(filePath);
      if (info.size > 1_048_576)
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      const text = yield* fs.readFileString(filePath);
      if (new TextEncoder().encode(text).length > 1_048_576)
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      return text;
    });
  return EnterpriseWorkspaceService.of({
    readSnapshotFailure: (input) =>
      invoke(input, {
        type: "read_snapshot_failure",
        handoff: input.handoff,
        checks: input.checks,
      }).pipe(
        Effect.flatMap((result) =>
          "failure" in result && result.failure !== undefined
            ? decodeFailure(result.failure)
            : Effect.succeed(undefined),
        ),
        Effect.mapError(wrap),
      ),
    readSnapshotGate: (input) =>
      invoke(input, {
        type: "read_snapshot_gate",
        handoff: input.handoff,
        artifactId: input.artifactId,
      }).pipe(
        Effect.flatMap((result) =>
          "gate" in result
            ? decodeSnapshotResult(result.gate).pipe(Effect.mapError(wrap))
            : Effect.fail(new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" })),
        ),
      ),
    gateSnapshot: (input) =>
      invoke(input, { type: "snapshot_gate", handoff: input.handoff, checks: input.checks }).pipe(
        Effect.flatMap((result) =>
          "gate" in result
            ? decodeSnapshotResult(result.gate).pipe(Effect.mapError(wrap))
            : Effect.fail(new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" })),
        ),
        Effect.mapError(wrap),
      ),
    prepare: (input) => invoke(input, "prepare"),
    cleanup: (input) => invoke(input, "cleanup"),
    releaseBindings: (input) => invoke(input, { type: "release_v2", threadIds: input.threadIds }),
    readAutomation: (input) =>
      invoke(input, { type: "read_automation" }).pipe(
        Effect.flatMap((result) =>
          "automation" in result && result.automation !== undefined
            ? decodeAutomationValue(result.automation)
            : Effect.succeed(undefined),
        ),
        Effect.mapError(wrap),
      ),
    writeAutomation: (input) =>
      invoke(input, { type: "write_automation", record: input.record }).pipe(Effect.asVoid),
    bindWorkflow: (input) =>
      invoke(input, { type: "bind_workflow", key: input.key }).pipe(Effect.asVoid),
    bindThread: (input) => invoke(input, { type: "bind_v2", threadId: input.threadId }),
    prepareFile: (input) =>
      readFile(input.specPath).pipe(
        Effect.flatMap(decodeSpecFile),
        Effect.flatMap((spec) => invoke({ ...input, spec }, "prepare")),
        Effect.mapError(wrap),
      ),
    cleanupFile: (input) =>
      readFile(input.specPath).pipe(
        Effect.flatMap(decodeSpecFile),
        Effect.flatMap((spec) => invoke({ ...input, spec }, "cleanup")),
        Effect.mapError(wrap),
      ),
    gateFile: (input) =>
      Effect.gen(function* () {
        const spec = yield* decodeSpecFile(yield* readFile(input.specPath));
        const plan = yield* decodeGatePlan(yield* readFile(input.planPath));
        return yield* invoke({ ...input, spec }, plan);
      }).pipe(Effect.mapError(wrap)),
    checkFile: (input) =>
      Effect.gen(function* () {
        const spec = yield* decodeSpecFile(yield* readFile(input.specPath));
        const check = yield* decodeCheckFile(yield* readFile(input.checkPath));
        return yield* invoke({ ...input, spec }, check);
      }).pipe(Effect.mapError(wrap)),
  });
});
export const layerWithSandbox = Layer.effect(EnterpriseWorkspaceService, make).pipe(
  Layer.provide(Layer.mergeAll(Git.layer, Secrets.layer.pipe(Layer.provide(Git.layer)))),
);
export const layer = layerWithSandbox.pipe(
  Layer.provide(Sandbox.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
