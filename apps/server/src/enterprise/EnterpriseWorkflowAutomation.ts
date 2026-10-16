import {
  AuthSessionId,
  CommandId,
  EnterpriseCancelWorkflowResult,
  EnterpriseAdvanceWorkflowInput,
  EnterpriseReleaseWorkspaceInput,
  EnterpriseRoleError,
  EnterpriseStartWorkflowResult,
  EnterpriseWorkflowAutomationRecord,
  EnterpriseWorkflowAutomationStatus,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Workflow from "./EnterpriseWorkflowService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import {
  enterpriseTaskKey,
  normalizeEnterpriseWorkflow,
} from "./EnterpriseWorkflowConfiguration.ts";
import { enterpriseSecretKinds } from "./EnterpriseSecretPolicy.ts";
import { EnterpriseTenancy } from "./EnterpriseTenancy.ts";

const decodeInput = Schema.decodeUnknownEffect(EnterpriseAdvanceWorkflowInput);
const decodeScope = Schema.decodeUnknownEffect(EnterpriseReleaseWorkspaceInput);
const decodeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EnterpriseWorkflowAutomationRecord),
);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(EnterpriseWorkflowAutomationRecord));
const isRoleError = Schema.is(EnterpriseRoleError);
const required = ["orchestration:operate", "filesystem:write", "source-control:write"] as const;
const status = (
  record: EnterpriseWorkflowAutomationRecord | undefined,
): EnterpriseWorkflowAutomationStatus => ({
  registered: record !== undefined,
  enabled: record?.enabled ?? false,
  stopReason: record?.stopReason ?? null,
});
const params = (input: EnterpriseAdvanceWorkflowInput | EnterpriseReleaseWorkspaceInput) => ({
  spec: input.task,
  repositoryRoot: input.repositoryRoot,
  workspacesRoot: input.workspacesRoot,
});

export class EnterpriseWorkflowAutomation extends Context.Service<
  EnterpriseWorkflowAutomation,
  {
    /** Re-checks the owner session (not revoked, not expired, all three scopes) before any background step. */
    readonly authorize: (sessionId: AuthSessionId) => Effect.Effect<void, EnterpriseRoleError>;
    /** Registers opt-in background automation for the caller's session and advances the first stage. */
    readonly start: (
      input: EnterpriseAdvanceWorkflowInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<EnterpriseStartWorkflowResult, EnterpriseRoleError>;
    /** Persists cancellation intent, then sends V2 `thread.stop` to every bound role thread. Retries partial dispatch. */
    readonly cancel: (
      input: EnterpriseReleaseWorkspaceInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<EnterpriseCancelWorkflowResult, EnterpriseRoleError>;
    /** Disables further automatic steps after any in-flight advance finishes; does not interrupt provider turns. */
    readonly stop: (
      input: EnterpriseReleaseWorkspaceInput,
    ) => Effect.Effect<EnterpriseWorkflowAutomationStatus, EnterpriseRoleError>;
    /** Reports whether automation is registered, enabled and why it stopped. */
    readonly status: (
      input: EnterpriseReleaseWorkspaceInput,
    ) => Effect.Effect<EnterpriseWorkflowAutomationStatus, EnterpriseRoleError>;
    /** One scheduler tick: advances registered workflows whose V2 event sequences changed. */
    readonly sweep: Effect.Effect<void, EnterpriseRoleError>;
  }
>()("t3/enterprise/EnterpriseWorkflowAutomation") {}

const make = Effect.gen(function* () {
  const workflow = yield* Workflow.EnterpriseWorkflowService;
  const workspace = yield* Workspace.EnterpriseWorkspaceService;
  const threads = yield* Threads.ThreadManagementService;
  const sessions = yield* Sessions.AuthSessionRepository;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const tenancy = yield* EnterpriseTenancy;
  const permit = yield* Semaphore.make(1);
  const seen = new Map<string, string>();
  const authorize = Effect.fn("EnterpriseWorkflowAutomation.authorize")(function* (
    sessionId: AuthSessionId,
  ) {
    const session = yield* sessions.getById({ sessionId });
    const now = yield* DateTime.now;
    if (
      session._tag === "None" ||
      session.value.revokedAt !== null ||
      DateTime.toEpochMillis(session.value.expiresAt) <= DateTime.toEpochMillis(now) ||
      required.some((scope) => !session.value.scopes.includes(scope))
    )
      return yield* new EnterpriseRoleError({ reason: "authorization_required" });
  });
  /**
   * Background steps run without a client, so both the owner session and the task's tenant are
   * re-checked on every tick: revoking either stops the workflow at its next step.
   */
  const authorizeRecord = (record: EnterpriseWorkflowAutomationRecord) =>
    authorize(record.ownerSessionId).pipe(
      Effect.andThen(
        tenancy
          .authorize(record.input.task.tenantId)
          .pipe(Effect.mapError(() => new EnterpriseRoleError({ reason: "tenant_not_allowed" }))),
      ),
    );
  const start = Effect.fn("EnterpriseWorkflowAutomation.start")(function* (
    raw: EnterpriseAdvanceWorkflowInput,
    sessionId: AuthSessionId,
  ) {
    yield* authorize(sessionId);
    const input = normalizeEnterpriseWorkflow(yield* decodeInput(raw));
    const record = {
      version: 1 as const,
      input,
      ownerSessionId: sessionId,
      enabled: true,
      stopReason: null,
    };
    const contents = yield* encodeRecord(record);
    if (
      new TextEncoder().encode(contents).length > 1_048_576 ||
      enterpriseSecretKinds(contents).length > 0
    )
      return yield* new EnterpriseRoleError({ reason: "invalid_input" });
    const state = yield* workflow.advance(input);
    const saved = {
      ...record,
      enabled: state.state === "running" || state.state === "waiting_checkpoint",
      stopReason:
        state.state === "ready"
          ? ("ready" as const)
          : state.state === "blocked"
            ? ("blocked" as const)
            : null,
    };
    // Advance commits the initial V2 thread before registration can be acknowledged.
    yield* workspace.writeAutomation({ ...params(input), record: saved });
    seen.delete(yield* enterpriseTaskKey(input.task));
    return { automation: status(saved), state };
  });
  const stop = Effect.fn("EnterpriseWorkflowAutomation.stop")(function* (
    raw: EnterpriseReleaseWorkspaceInput,
  ) {
    const input = yield* decodeScope(raw);
    const record = yield* workspace.readAutomation(params(input));
    if (record === undefined) return status(undefined);
    const saved = { ...record, enabled: false, stopReason: "manual" as const };
    yield* workspace.writeAutomation({ ...params(input), record: saved });
    seen.delete(yield* enterpriseTaskKey(input.task));
    return status(saved);
  });
  const dispatchCancellation = Effect.fn("EnterpriseWorkflowAutomation.dispatchCancellation")(
    function* (input: EnterpriseAdvanceWorkflowInput) {
      const owned = yield* workspace.prepare(params(input));
      const key = yield* enterpriseTaskKey(input.task);
      const targets = [];
      // Validate every binding before stopping any thread. V2 remains the source of run identity.
      for (const threadId of owned.boundThreadIds ?? []) {
        if (
          !new RegExp(`^enterprise:${key}:(architect|coder|qa|fix[12]:(coder|qa))$`).test(threadId)
        )
          return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
        const projection = yield* threads.getProjectThread({
          projectId: input.task.projectId,
          threadId,
        });
        if (projection.thread.worktreePath !== owned.worktreePath)
          return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
        if (projection.thread.deletedAt !== null) continue;
        const latest = projection.runs.at(-1);
        const active = projection.runs.findLast(
          (run) => run.status !== "queued" && !Threads.isTerminalRunStatus(run.status),
        );
        // A new attempt must not replay an older Stop receipt for the same run.
        const attempt = active?.activeAttemptId ?? latest?.activeAttemptId ?? "none";
        targets.push({
          threadId,
          commandId: CommandId.make(`${threadId}:cancel:${latest?.id ?? "idle"}:${attempt}`),
        });
      }
      for (const target of targets)
        yield* threads.dispatch({
          ...target,
          type: "thread.stop",
          reason: "Enterprise workflow cancelled",
        });
      return targets;
    },
  );
  const cancel = Effect.fn("EnterpriseWorkflowAutomation.cancel")(function* (
    raw: EnterpriseReleaseWorkspaceInput,
    sessionId: AuthSessionId,
  ) {
    yield* authorize(sessionId);
    const input = yield* decodeScope(raw);
    const record = yield* workspace.readAutomation(params(input));
    if (record === undefined) return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const saved = {
      ...record,
      ownerSessionId: sessionId,
      enabled: false,
      stopReason: "cancelled" as const,
    };
    // Persist cancellation before dispatch; retries reuse V2 command receipts after partial failure.
    yield* workspace.writeAutomation({ ...params(input), record: saved });
    seen.delete(yield* enterpriseTaskKey(input.task));
    return { automation: status(saved), stopRequests: yield* dispatchCancellation(record.input) };
  });
  const candidate = Effect.fn("EnterpriseWorkflowAutomation.candidate")(function* (
    thread: OrchestrationV2ThreadShell,
  ) {
    const match = /^enterprise:([a-f0-9]{64}):architect$/.exec(thread.id);
    if (match === null || thread.worktreePath === null) return undefined;
    const control = path.dirname(thread.worktreePath);
    if (path.basename(thread.worktreePath) !== "checkout" || path.basename(control) !== match[1])
      return undefined;
    const file = path.join(control, "workflow-automation.json");
    if (!(yield* fs.exists(file))) return undefined;
    if (
      (yield* fs.realPath(control)) !== control ||
      (yield* fs.realPath(file)) !== file ||
      (yield* fs.stat(file)).size > 1_048_576
    )
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const contents = yield* fs.readFileString(file);
    if (new TextEncoder().encode(contents).length > 1_048_576)
      return yield* new EnterpriseRoleError({ reason: "context_too_large" });
    const record = yield* decodeRecord(contents);
    if (
      (yield* enterpriseTaskKey(record.input.task)) !== match[1] ||
      record.input.task.projectId !== thread.projectId ||
      (yield* fs.realPath(record.input.workspacesRoot)) !== path.dirname(control)
    )
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    return yield* workspace.readAutomation(params(record.input));
  });
  const sweep = Effect.fn("EnterpriseWorkflowAutomation.sweep")(function* () {
    const shell = yield* threads.getShellSnapshot({ location: "active" });
    const candidates = shell.threads.filter((thread) =>
      /^enterprise:[a-f0-9]{64}:architect$/.test(thread.id),
    );
    const keys = new Set(candidates.map((thread) => thread.id.split(":")[1]!));
    for (const key of seen.keys()) if (!keys.has(key)) seen.delete(key);
    for (const thread of candidates) {
      yield* Effect.gen(function* () {
        const record = yield* candidate(thread);
        if (record === undefined || (!record.enabled && record.stopReason !== "cancelled")) return;
        const key = yield* enterpriseTaskKey(record.input.task);
        const members = shell.threads
          .filter((member) => member.id.startsWith(`enterprise:${key}:`))
          .toSorted((a, b) => a.id.localeCompare(b.id));
        const sequences = yield* Effect.forEach(members, (member) =>
          threads.getThreadEventSequence(member.id),
        );
        const fingerprint = members
          .map((member, index) => `${member.id}:${sequences[index]}`)
          .join("|");
        if (seen.get(key) === fingerprint) return;
        if (record.stopReason === "cancelled") {
          // Leave intent intact on dispatch failure so the next scheduler tick can retry.
          const authorized = yield* authorizeRecord(record).pipe(Effect.result);
          if (authorized._tag === "Failure") {
            yield* workspace.writeAutomation({
              ...params(record.input),
              record: { ...record, enabled: false, stopReason: "authorization_required" },
            });
            return;
          }
          yield* dispatchCancellation(record.input);
          seen.set(key, fingerprint);
          return;
        }
        const outcome = yield* authorizeRecord(record).pipe(
          Effect.andThen(workflow.advance(record.input)),
          Effect.result,
        );
        if (outcome._tag === "Failure") {
          const cause = outcome.failure;
          if (
            cause._tag === "EnterpriseRoleError" &&
            cause.cause &&
            typeof cause.cause === "object" &&
            "reason" in cause.cause &&
            cause.cause.reason === "busy"
          )
            return;
          const reason =
            cause._tag === "EnterpriseRoleError" &&
            (cause.reason === "authorization_required" || cause.reason === "tenant_not_allowed")
              ? ("authorization_required" as const)
              : ("error" as const);
          yield* workspace.writeAutomation({
            ...params(record.input),
            record: { ...record, enabled: false, stopReason: reason },
          });
          yield* Effect.logWarning("enterprise.workflow.automation-stopped", { reason });
        } else if (outcome.success.state === "ready" || outcome.success.state === "blocked") {
          yield* workspace.writeAutomation({
            ...params(record.input),
            record: { ...record, enabled: false, stopReason: outcome.success.state },
          });
        }
        seen.set(key, fingerprint);
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("enterprise.workflow.automation-registration-unavailable"),
        ),
      );
    }
  });
  const wrap = (cause: unknown) =>
    isRoleError(cause) ? cause : new EnterpriseRoleError({ reason: "launch_failed", cause });
  return EnterpriseWorkflowAutomation.of({
    authorize: (sessionId) =>
      authorize(sessionId).pipe(
        Effect.mapError((cause) =>
          cause._tag === "EnterpriseRoleError"
            ? cause
            : new EnterpriseRoleError({ reason: "authorization_required", cause }),
        ),
      ),
    start: (input, sessionId) =>
      start(input, sessionId).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        permit.withPermits(1),
        Effect.mapError(wrap),
      ),
    cancel: (input, sessionId) =>
      cancel(input, sessionId).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        permit.withPermits(1),
        Effect.mapError(wrap),
      ),
    stop: (input) =>
      stop(input).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        permit.withPermits(1),
        Effect.mapError(wrap),
      ),
    status: (raw) =>
      decodeScope(raw).pipe(
        Effect.flatMap((input) => workspace.readAutomation(params(input))),
        Effect.map(status),
        Effect.mapError(wrap),
      ),
    sweep: sweep().pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      permit.withPermits(1),
      Effect.mapError(wrap),
    ),
  });
});
export const layer = Layer.effect(EnterpriseWorkflowAutomation, make);
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const automation = yield* EnterpriseWorkflowAutomation;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("enterprise-workflows", automation.sweep);
  }),
);
