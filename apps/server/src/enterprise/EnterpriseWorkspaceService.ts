import {
  AgentHandoff,
  type EnterpriseApprovalEntry,
  type EnterpriseApprovalRecord,
  EnterpriseSnapshotGateFailure,
  EnterpriseSnapshotGateResult,
  EnterpriseWorkflowAutomationRecord,
  TaskSpec,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Sandbox from "./EnterpriseSandboxService.ts";
import * as Secrets from "./EnterpriseSecretService.ts";
import { EnterpriseTenancy } from "./EnterpriseTenancy.ts";
import { MAX_WORKSPACE_FILE_BYTES } from "./EnterpriseWorkspaceArtifacts.ts";

import {
  Ownership,
  decodeCheckFile,
  decodeGatePlan,
  decodeSpecFile,
} from "./EnterpriseWorkspaceArtifacts.ts";
import * as Approvals from "./EnterpriseWorkspaceApprovals.ts";
import * as Automation from "./EnterpriseWorkspaceAutomation.ts";
import * as Checks from "./EnterpriseWorkspaceChecks.ts";
import {
  EnterpriseWorkspaceError,
  EnterpriseWorkspaceRejected,
} from "./EnterpriseWorkspaceErrors.ts";
import * as Evidence from "./EnterpriseWorkspaceEvidence.ts";
import * as Lifecycle from "./EnterpriseWorkspaceLifecycle.ts";
import * as Snapshot from "./EnterpriseWorkspaceSnapshot.ts";
export {
  EnterpriseWorkspaceError,
  EnterpriseWorkspaceRejected,
} from "./EnterpriseWorkspaceErrors.ts";

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
    /** Stored approval decisions for the task; evidence for revalidation, never authorization. */
    readonly readApprovals: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      EnterpriseApprovalRecord | undefined,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Lock-free read of atomic approval evidence for polling; never authorization. */
    readonly peekApprovals: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
    }) => Effect.Effect<
      EnterpriseApprovalRecord | undefined,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
    /** Appends one decision under the ownership lock; same session + commit replaces its earlier one. */
    readonly appendApproval: (input: {
      readonly spec: TaskSpec;
      readonly repositoryRoot: string;
      readonly workspacesRoot: string;
      readonly entry: EnterpriseApprovalEntry;
    }) => Effect.Effect<
      EnterpriseApprovalRecord,
      EnterpriseWorkspaceRejected | EnterpriseWorkspaceError
    >;
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
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | Crypto.Crypto
    | Git.GitVcsDriver
    | Sandbox.EnterpriseSandboxService
    | Secrets.EnterpriseSecretService
  >();
  const tenancy = yield* EnterpriseTenancy;
  const fs = yield* FileSystem.FileSystem;
  const execute = <
    A,
    R extends
      | FileSystem.FileSystem
      | Path.Path
      | Crypto.Crypto
      | Git.GitVcsDriver
      | Sandbox.EnterpriseSandboxService
      | Secrets.EnterpriseSecretService
      | EnterpriseTenancy,
  >(
    effect: Effect.Effect<
      A,
      | Effect.Error<ReturnType<typeof Lifecycle.prepare>>
      | Effect.Error<ReturnType<typeof Snapshot.gateSnapshot>>,
      R
    >,
  ) =>
    effect.pipe(
      Effect.provideService(EnterpriseTenancy, tenancy),
      Effect.provide(context),
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
      if (info.size > MAX_WORKSPACE_FILE_BYTES)
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      const text = yield* fs.readFileString(filePath);
      if (new TextEncoder().encode(text).length > MAX_WORKSPACE_FILE_BYTES)
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      return text;
    });
  return EnterpriseWorkspaceService.of({
    prepare: (input) => execute(Lifecycle.prepare(input)),
    cleanup: (input) => execute(Lifecycle.cleanup(input)),
    bindThread: (input) => execute(Lifecycle.bindThread(input)),
    releaseBindings: (input) => execute(Lifecycle.releaseBindings(input)),
    bindWorkflow: (input) => execute(Lifecycle.bindWorkflow(input)).pipe(Effect.asVoid),
    readAutomation: (input) => execute(Automation.readAutomation(input)),
    writeAutomation: (input) => execute(Automation.writeAutomation(input)),
    peekApprovals: (input) => execute(Approvals.peekApprovals(input)),
    readApprovals: (input) => execute(Approvals.readApprovals(input)),
    appendApproval: (input) => execute(Approvals.appendApproval(input)),
    readSnapshotFailure: (input) => execute(Evidence.readSnapshotFailure(input)),
    readSnapshotGate: (input) => execute(Evidence.readSnapshotGate(input)),
    gateSnapshot: (input) => execute(Snapshot.gateSnapshot(input)),
    prepareFile: (input) =>
      readFile(input.specPath).pipe(
        Effect.flatMap(decodeSpecFile),
        Effect.flatMap((spec) => execute(Lifecycle.prepare({ ...input, spec }))),
        Effect.mapError(wrap),
      ),
    cleanupFile: (input) =>
      readFile(input.specPath).pipe(
        Effect.flatMap(decodeSpecFile),
        Effect.flatMap((spec) => execute(Lifecycle.cleanup({ ...input, spec }))),
        Effect.mapError(wrap),
      ),
    gateFile: (input) =>
      Effect.gen(function* () {
        const spec = yield* decodeSpecFile(yield* readFile(input.specPath));
        const checks = yield* decodeGatePlan(yield* readFile(input.planPath));
        return yield* execute(Checks.runChecks({ ...input, spec, checks, batch: true }));
      }).pipe(Effect.mapError(wrap)),
    checkFile: (input) =>
      Effect.gen(function* () {
        const spec = yield* decodeSpecFile(yield* readFile(input.specPath));
        const check = yield* decodeCheckFile(yield* readFile(input.checkPath));
        return yield* execute(Checks.runChecks({ ...input, spec, checks: [check], batch: false }));
      }).pipe(Effect.mapError(wrap)),
  });
});
export const layerWithSandbox = Layer.effect(EnterpriseWorkspaceService, make).pipe(
  Layer.provide(Layer.mergeAll(Git.layer, Secrets.layer.pipe(Layer.provide(Git.layer)))),
);
export const layer = layerWithSandbox.pipe(
  Layer.provide(Sandbox.layer.pipe(Layer.provide(ProcessRunner.layer))),
);
