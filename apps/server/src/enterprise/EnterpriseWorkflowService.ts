import { priceUsage } from "./EnterpriseCost.ts";
import * as DateTime from "effect/DateTime";
import {
  enterpriseRoleRun,
  isEnterpriseRoleMessage,
  isDocumentationPath,
} from "./EnterpriseRun.ts";
import {
  candidateKey,
  recordProviderFailure,
  routeWork,
  selectModel,
  type CooldownState,
} from "./EnterpriseRouting.ts";
import {
  CommandId,
  EnterpriseAdvanceWorkflowInput,
  EnterpriseAdvanceWorkflowResult,
  EnterpriseRoleError,
  ThreadId,
  type EnterpriseRole,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { EnterprisePricing } from "./EnterprisePricing.ts";
import * as Roles from "./EnterpriseRoleService.ts";
import { evaluateTaskBudget } from "./EnterpriseTaskCost.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import {
  enterpriseWorkflowKey,
  normalizeEnterpriseWorkflow,
} from "./EnterpriseWorkflowConfiguration.ts";

const decodeInput = Schema.decodeUnknownEffect(EnterpriseAdvanceWorkflowInput);
const decodeResult = Schema.decodeUnknownEffect(EnterpriseAdvanceWorkflowResult);
type Revision = 0 | 1 | 2;
/**
 * `advance` may dispatch the next stage; `verify` re-checks an existing result and never starts,
 * retries or stops provider work. Publication uses `verify` so it cannot advance a workflow.
 */
type AdvanceMode = "advance" | "verify";
/** Raised in `verify` mode wherever `advance` would have dispatched new provider work. */
const notReady = () => new EnterpriseRoleError({ reason: "predecessor_incomplete" });

export class EnterpriseWorkflowService extends Context.Service<
  EnterpriseWorkflowService,
  {
    /** Idempotently moves the workflow to its next V2-backed stage. */
    readonly advance: (
      input: EnterpriseAdvanceWorkflowInput,
    ) => Effect.Effect<EnterpriseAdvanceWorkflowResult, EnterpriseRoleError>;
    /**
     * Re-validates a finished workflow (including a fresh deterministic gate) without dispatching
     * provider work. Fails with `predecessor_incomplete` when a stage would still need to run.
     */
    readonly verify: (
      input: EnterpriseAdvanceWorkflowInput,
    ) => Effect.Effect<EnterpriseAdvanceWorkflowResult, EnterpriseRoleError>;
  }
>()("t3/enterprise/EnterpriseWorkflowService") {}

const make = Effect.gen(function* () {
  const roles = yield* Roles.EnterpriseRoleService;
  const workspace = yield* Workspace.EnterpriseWorkspaceService;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const pricing = yield* EnterprisePricing;
  const evaluate = Effect.fn("EnterpriseWorkflowService.evaluate")(function* (
    raw: EnterpriseAdvanceWorkflowInput,
    mode: AdvanceMode,
  ) {
    const decoded = yield* decodeInput(raw).pipe(
      Effect.mapError((cause) => new EnterpriseRoleError({ reason: "invalid_input", cause })),
    );
    const input = normalizeEnterpriseWorkflow(decoded);
    if (
      !input.task.approvedTools.includes("codex.workspace_read") ||
      !input.task.approvedTools.includes("codex.workspace_write") ||
      input.plan.some((check) => !input.task.approvedTools.includes(check.tool))
    )
      return yield* new EnterpriseRoleError({ reason: "tool_not_allowed" });
    const project = yield* projects.get(input.task.projectId);
    if (
      project._tag === "None" ||
      (yield* fs.realPath(project.value.workspaceRoot)) !==
        (yield* fs.realPath(input.repositoryRoot))
    )
      return yield* new EnterpriseRoleError({ reason: "project_mismatch" });
    const params = {
      spec: input.task,
      repositoryRoot: input.repositoryRoot,
      workspacesRoot: input.workspacesRoot,
    };
    const owned = yield* workspace.prepare(params);
    if (owned.retired) return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    // Bind only a digest of immutable configuration, never another stage/run ledger.
    yield* workspace.bindWorkflow({ ...params, key: yield* enterpriseWorkflowKey(input) });
    const identity = owned.branch.slice("enterprise/task-".length);
    const records: Array<{
      role: EnterpriseRole;
      revision: Revision;
      threadId: ThreadId;
      projection: OrchestrationV2ThreadProjection | undefined;
    }> = [];
    for (const revision of [0, 1, 2] as const) {
      for (const role of (revision === 0
        ? ["architect", "coder", "qa"]
        : ["coder", "qa"]) as EnterpriseRole[]) {
        const threadId = ThreadId.make(
          `enterprise:${identity}:${revision === 0 ? "" : `fix${revision}:`}${role}`,
        );
        const projection = yield* threads
          .getProjectThread({ projectId: input.task.projectId, threadId })
          .pipe(
            Effect.catchTags({
              ThreadManagementThreadNotFoundError: () => Effect.succeed(undefined),
            }),
          );
        if (
          projection !== undefined &&
          (!owned.boundThreadIds?.includes(threadId) ||
            projection.thread.worktreePath !== owned.worktreePath)
        )
          return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
        records.push({ role, revision, threadId, projection });
      }
    }
    // Per-task circuit breaker. Only enforced when an operator configured prices; otherwise
    // cost stays unknown, as before.
    const prices = yield* pricing.load;
    const projections = records.flatMap((record) =>
      record.projection === undefined ? [] : [record.projection],
    );
    if (input.routing !== undefined && prices === undefined)
      return yield* decodeResult({ state: "blocked", reason: "cost_unknown" });
    if (prices !== undefined) {
      const { decision } = evaluateTaskBudget({
        projections,
        prices,
        limitCents: input.task.budgetLimit.limitCents,
      });
      if (decision.status === "tripped") {
        // Stop in-flight runs so a runaway loop does not keep spending; stable command ids make retries idempotent.
        for (const record of mode === "advance" ? records : []) {
          const active = record.projection?.runs.findLast(
            (run) => run.status !== "queued" && !Threads.isTerminalRunStatus(run.status),
          );
          if (active === undefined) continue;
          yield* threads.dispatch({
            threadId: record.threadId,
            commandId: CommandId.make(`${record.threadId}:budget:${active.id}`),
            type: "thread.stop",
            reason: "Enterprise task budget exceeded",
          });
        }
        return yield* decodeResult({ state: "blocked", reason: decision.reason });
      }
    }
    const nowEpochMillis = DateTime.toEpochMillis(yield* DateTime.now);
    let cooldowns: CooldownState = {};
    for (const record of records) {
      const projection = record.projection;
      if (projection === undefined) continue;
      for (const run of projection.runs) {
        if (run.status !== "failed") continue;
        const error = projection.turnItems?.findLast(
          (item) => item.type === "error" && item.runId === run.id,
        );
        if (error?.type !== "error") continue;
        const code =
          error.failure.class === "usage_limit"
            ? 429
            : Number((error.failure.code ?? "").replace(/^http[_-]/, ""));
        const ended =
          run.completedAt === null || run.completedAt === undefined
            ? nowEpochMillis
            : DateTime.toEpochMillis(run.completedAt);
        const reset = error.failure.resetAt == null ? NaN : Date.parse(error.failure.resetAt);
        const failed = {
          instanceId: run.modelSelection.instanceId,
          model: run.modelSelection.model,
          tier: run.modelSelection.model.startsWith("ollama/")
            ? ("local" as const)
            : ("cloud" as const),
        };
        const next = recordProviderFailure({
          cooldowns,
          failed,
          status: code,
          nowEpochMillis: ended,
          ...(Number.isFinite(reset) ? { retryAfterMs: reset - ended } : {}),
        });
        cooldowns = {
          ...next,
          [candidateKey(failed)]: Math.max(
            cooldowns[candidateKey(failed)] ?? 0,
            next[candidateKey(failed)] ?? 0,
          ),
        };
      }
    }
    const chooseModel = (record: (typeof records)[number], pinned = true, forceCloud = false) =>
      Effect.gen(function* () {
        const previous =
          record.projection === undefined
            ? undefined
            : enterpriseRoleRun(record.projection, record.threadId);
        if (pinned && previous !== undefined) return previous.modelSelection;
        if (input.routing === undefined) return input.modelSelection;
        let docsOnly = false;
        if (record.role === "coder" && input.routing.preferLocalDocs) {
          const spec = yield* roles.collectRoleArtifact({
            ...input,
            role: "architect",
            revision: 0,
          });
          docsOnly =
            spec.output.kind === "enterprise_spec" &&
            spec.output.affectedPaths.every(isDocumentationPath);
        }
        const candidates = input.routing.candidates
          .filter(
            (candidate) =>
              (pinned ||
                previous?.status !== "failed" ||
                candidate.selection.model !== previous.modelSelection.model) &&
              prices !== undefined &&
              priceUsage({ inputTokens: 0, outputTokens: 0 }, prices[candidate.selection.model]) !==
                null,
          )
          .map((candidate) => ({
            instanceId: candidate.selection.instanceId,
            model: candidate.selection.model,
            tier: candidate.tier,
          }));
        const kind =
          record.role === "architect"
            ? "architecture"
            : record.role === "qa"
              ? "review"
              : docsOnly
                ? "docs"
                : "implementation";
        if (
          docsOnly &&
          !forceCloud &&
          !candidates.some((candidate) => candidate.tier === "local") &&
          !input.routing.allowCloudFallback
        )
          return undefined;
        const route = forceCloud
          ? { tier: "cloud" as const }
          : routeWork({
              kind,
              criticalChanges: [],
              localAvailable: candidates.some((candidate) => candidate.tier === "local"),
            });
        const selected = selectModel({
          tier: route.tier,
          candidates,
          cooldowns,
          nowEpochMillis,
          allowCloudFallback: input.routing.allowCloudFallback,
        });
        if (selected.status !== "selected") return undefined;
        return input.routing.candidates.find(
          (candidate) =>
            candidate.selection.instanceId === selected.candidate.instanceId &&
            candidate.selection.model === selected.candidate.model,
        )?.selection;
      });
    // Manual turns and closed threads require human reconciliation rather than
    // silently treating an old initial checkpoint as the user's latest work.
    for (const record of records) {
      const projection = record.projection;
      if (projection === undefined) continue;
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null)
        return yield* decodeResult({ state: "blocked", reason: "thread_closed" });
      if (
        projection.runs.some((run) => !isEnterpriseRoleMessage(record.threadId, run.userMessageId))
      )
        return yield* decodeResult({ state: "blocked", reason: "unexpected_run" });
      const run = enterpriseRoleRun(projection, record.threadId);
      if (run !== undefined) {
        if (["failed", "cancelled", "interrupted", "rolled_back"].includes(run.status)) {
          if (mode === "advance" && run.status === "failed" && input.routing !== undefined) {
            const modelSelection = yield* chooseModel(
              record,
              false,
              !run.modelSelection.model.startsWith("ollama/"),
            );
            if (
              modelSelection !== undefined &&
              modelSelection.model !== run.modelSelection.model &&
              modelSelection.model.startsWith("ollama/") ===
                run.modelSelection.model.startsWith("ollama/")
            ) {
              const retried = yield* roles
                .retry({ ...input, role: record.role, revision: record.revision, modelSelection })
                .pipe(Effect.result);
              if (retried._tag === "Success")
                return yield* decodeResult({
                  state: "running",
                  role: record.role,
                  revision: record.revision,
                  threadId: record.threadId,
                });
            }
          }
          return yield* decodeResult({ state: "blocked", reason: "failed_run" });
        }
        if (run.status !== "completed")
          return yield* decodeResult({
            state: "running",
            role: record.role,
            revision: record.revision,
            threadId: record.threadId,
          });
      }
    }
    const inspect = (record: (typeof records)[number]) =>
      Effect.gen(function* () {
        const run =
          record.projection === undefined
            ? undefined
            : enterpriseRoleRun(record.projection, record.threadId);
        if (run === undefined) {
          if (mode === "verify") return yield* notReady();
          const modelSelection = yield* chooseModel(record);
          if (modelSelection === undefined)
            return yield* decodeResult({ state: "blocked", reason: "model_unavailable" });
          yield* roles
            .launch({ ...input, role: record.role, revision: record.revision, modelSelection })
            .pipe(
              Effect.catchTags({
                EnterpriseRoleError: (error) =>
                  Effect.gen(function* () {
                    if (
                      error.reason !== "provider_unsupported" ||
                      !modelSelection.model.startsWith("ollama/") ||
                      !input.routing?.allowCloudFallback
                    )
                      return yield* error;
                    const cloud = yield* chooseModel(record, false, true);
                    if (cloud === undefined) return yield* error;
                    return yield* roles.launch({
                      ...input,
                      role: record.role,
                      revision: record.revision,
                      modelSelection: cloud,
                    });
                  }),
              }),
            );
          return yield* decodeResult({
            state: "running",
            role: record.role,
            revision: record.revision,
            threadId: record.threadId,
          });
        }
        if (["failed", "cancelled", "interrupted", "rolled_back"].includes(run.status))
          return yield* decodeResult({ state: "blocked", reason: "failed_run" });
        if (run.status !== "completed")
          return yield* decodeResult({
            state: "running",
            role: record.role,
            revision: record.revision,
            threadId: record.threadId,
          });
        const checkpoint = record.projection?.checkpoints.find(
          (checkpoint) => checkpoint.id === run.checkpointId,
        );
        if (checkpoint?.status === "error" || checkpoint?.status === "stale")
          return yield* decodeResult({ state: "blocked", reason: "checkpoint_unavailable" });
        if (checkpoint?.status !== "ready")
          return yield* decodeResult({
            state: "waiting_checkpoint",
            role: record.role,
            revision: record.revision,
            threadId: record.threadId,
          });
        return undefined;
      });
    const architect = records[0]!;
    const architectState = yield* inspect(architect);
    if (architectState !== undefined) return architectState;
    yield* roles.collectRoleArtifact({ ...input, role: "architect", revision: 0 });
    const revision =
      records.findLast((record) => record.role === "coder" && record.projection !== undefined)
        ?.revision ?? 0;
    const coder = records.find(
      (record) => record.role === "coder" && record.revision === revision,
    )!;
    const coderState = yield* inspect(coder);
    if (coderState !== undefined) return coderState;
    yield* roles.collectHandoff({ ...input, role: "coder", revision });
    const qa = records.find((record) => record.role === "qa" && record.revision === revision)!;
    const qaState = yield* inspect(qa);
    if (qaState !== undefined) return qaState;
    const report = yield* roles.collectRoleArtifact({ ...input, role: "qa", revision });
    if (report.output.kind !== "enterprise_qa")
      return yield* new EnterpriseRoleError({ reason: "invalid_output" });
    if (report.output.verdict === "request_changes") {
      if (revision === 2)
        return yield* decodeResult({ state: "blocked", reason: "corrections_exhausted" });
      if (mode === "verify") return yield* notReady();
      const next = revision === 0 ? 1 : 2;
      const nextRecord = records.find(
        (record) => record.role === "coder" && record.revision === next,
      )!;
      const modelSelection = yield* chooseModel(nextRecord);
      if (modelSelection === undefined)
        return yield* decodeResult({ state: "blocked", reason: "model_unavailable" });
      const started = yield* roles.launch({
        ...input,
        role: "coder",
        revision: next,
        modelSelection,
      });
      return yield* decodeResult({
        state: "running",
        role: "coder",
        revision: next,
        threadId: started.threadId,
      });
    }
    if (mode === "verify") {
      // A failing gate is an error here: verification must not launch a correction round.
      const gate = yield* roles.gateRole({ ...input, role: "coder", revision });
      const draft = yield* roles.buildPullRequestDraft({
        ...input,
        role: "coder",
        revision,
        artifactId: gate.artifactId,
      });
      return yield* decodeResult({ state: "ready", revision, draft });
    }
    const nextRecord = records.find(
      (record) => record.role === "coder" && record.revision === Math.min(2, revision + 1),
    )!;
    const correctionModel = yield* chooseModel(nextRecord);
    if (correctionModel === undefined)
      return yield* decodeResult({ state: "blocked", reason: "model_unavailable" });
    const gate = yield* roles.gateAndContinue({
      ...input,
      role: "coder",
      revision,
      modelSelection: correctionModel,
    });
    if (gate.status === "blocked")
      return yield* decodeResult({ state: "blocked", reason: "corrections_exhausted" });
    if (gate.status === "fix_started")
      return yield* decodeResult({
        state: "running",
        role: "coder",
        revision: revision === 0 ? 1 : 2,
        threadId: gate.launch.threadId,
      });
    const draft = yield* roles.buildPullRequestDraft({
      ...input,
      role: "coder",
      revision,
      artifactId: gate.gate.artifactId,
    });
    return yield* decodeResult({ state: "ready", revision, draft });
  });
  const runIn = (mode: AdvanceMode) => (input: EnterpriseAdvanceWorkflowInput) =>
    evaluate(input, mode).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError((cause) =>
        cause._tag === "EnterpriseRoleError"
          ? cause
          : new EnterpriseRoleError({ reason: "launch_failed", cause }),
      ),
    );
  return EnterpriseWorkflowService.of({ advance: runIn("advance"), verify: runIn("verify") });
});
export const layer = Layer.effect(EnterpriseWorkflowService, make);
