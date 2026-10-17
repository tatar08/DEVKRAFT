import {
  ENTERPRISE_APPROVAL_MAX_MINUTES,
  ENTERPRISE_APPROVAL_POLICY_VERSION,
  EnterpriseApprovalError,
  EnterpriseApprovalStatus,
  EnterpriseGetApprovalInput,
  EnterpriseMergeTaskInput,
  EnterpriseMergeTaskResult,
  EnterpriseRecordApprovalInput,
  RiskDecision,
  getEnterpriseApprovalBlockers,
  type AuthSessionId,
  type EnterpriseAdvanceWorkflowInput,
  type EnterpriseApprovalEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Merge from "./EnterpriseMergeService.ts";
import { classifyEnterpriseRisk, requiredEnterpriseApprovers } from "./EnterpriseRiskPolicy.ts";
import { isEnterpriseSessionAuthorized } from "./EnterpriseSessionAuthorization.ts";
import * as Workflows from "./EnterpriseWorkflowService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeGetInput = Schema.decodeUnknownEffect(EnterpriseGetApprovalInput);
const decodeRecordInput = Schema.decodeUnknownEffect(EnterpriseRecordApprovalInput);
const decodeMergeInput = Schema.decodeUnknownEffect(EnterpriseMergeTaskInput);
const decodeRisk = Schema.decodeUnknownEffect(RiskDecision);
const decodeStatus = Schema.decodeUnknownEffect(EnterpriseApprovalStatus);
const decodeMergeResult = Schema.decodeUnknownEffect(EnterpriseMergeTaskResult);

const fail = (reason: EnterpriseApprovalError["reason"], cause?: unknown) =>
  new EnterpriseApprovalError({ reason, ...(cause === undefined ? {} : { cause }) });

export interface EnterpriseApprover {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
}

/**
 * Phase 4 approval gate. Decisions are bound to the authenticated session that made them and to
 * the exact verified commit and policy version. Every read recomputes the decision from the live
 * session state, the current verified commit, the policy and the clock, so a restart, reconnect,
 * revoked session or new commit can never revive an old approval. Merge execution only proceeds
 * with zero blockers and never pushes.
 */
export class EnterpriseApprovalService extends Context.Service<
  EnterpriseApprovalService,
  {
    readonly status: (
      input: EnterpriseGetApprovalInput,
    ) => Effect.Effect<EnterpriseApprovalStatus, EnterpriseApprovalError>;
    readonly record: (
      input: EnterpriseRecordApprovalInput,
      approver: EnterpriseApprover,
    ) => Effect.Effect<EnterpriseApprovalStatus, EnterpriseApprovalError>;
    readonly merge: (
      input: EnterpriseMergeTaskInput,
      requester: EnterpriseApprover,
    ) => Effect.Effect<EnterpriseMergeTaskResult, EnterpriseApprovalError>;
  }
>()("t3/enterprise/EnterpriseApprovalService") {}

const make = Effect.gen(function* () {
  const workflows = yield* Workflows.EnterpriseWorkflowService;
  const workspace = yield* Workspace.EnterpriseWorkspaceService;
  const sessions = yield* Sessions.AuthSessionRepository;
  const merge = yield* Merge.EnterpriseMergeService;
  const git = yield* Git.GitVcsDriver;

  const scope = (workflow: EnterpriseAdvanceWorkflowInput) => ({
    spec: workflow.task,
    repositoryRoot: workflow.repositoryRoot,
    workspacesRoot: workflow.workspacesRoot,
  });

  /** The verified draft for the current commit; re-runs the deterministic gate, never dispatches. */
  const verified = (workflow: EnterpriseAdvanceWorkflowInput) =>
    workflows.verify(workflow).pipe(
      Effect.mapError((cause) => fail("workflow_not_ready", cause)),
      Effect.flatMap((state) =>
        state.state === "ready"
          ? Effect.succeed(state.draft)
          : Effect.fail(fail("workflow_not_ready")),
      ),
    );

  /** Paths come from the server's own diff of base → verified commit, not from any agent report. */
  const changedPaths = (workflow: EnterpriseAdvanceWorkflowInput, commit: string) =>
    git
      .execute({
        operation: "EnterpriseApprovalService.changedPaths",
        cwd: workflow.repositoryRoot,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "diff",
          "--no-ext-diff",
          "--name-only",
          "-z",
          workflow.task.repoCommit,
          commit,
          "--",
        ],
        maxOutputBytes: 1_048_576,
      })
      .pipe(
        Effect.map((output) => output.stdout.split("\0").filter(Boolean)),
        Effect.mapError((cause) => fail("workflow_not_ready", cause)),
      );

  const evaluate = Effect.fn("EnterpriseApprovalService.evaluate")(function* (
    workflow: EnterpriseAdvanceWorkflowInput,
  ) {
    const draft = yield* verified(workflow);
    const evidence = draft.evidence;
    const classification = classifyEnterpriseRisk(yield* changedPaths(workflow, evidence.diffSha));
    const required = requiredEnterpriseApprovers(classification.tier);
    const record = yield* workspace
      .readApprovals(scope(workflow))
      .pipe(Effect.mapError((cause) => fail("storage_failed", cause)));
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const ignored: Array<{ sessionId: AuthSessionId; reason: EnterpriseApprovalStatusIgnored }> =
      [];
    const valid: Array<EnterpriseApprovalEntry> = [];
    for (const entry of record?.entries ?? []) {
      const reason: EnterpriseApprovalStatusIgnored | undefined =
        entry.diffSha !== evidence.diffSha
          ? "stale_diff"
          : entry.policyVersion !== ENTERPRISE_APPROVAL_POLICY_VERSION
            ? "policy_changed"
            : entry.expiresAt <= now
              ? "expired"
              : !(yield* isEnterpriseSessionAuthorized(sessions, entry.sessionId))
                ? "session_invalid"
                : undefined;
      if (reason === undefined) valid.push(entry);
      else ignored.push({ sessionId: entry.sessionId, reason });
    }
    const approvals = valid.filter((entry) => entry.decision === "approve");
    const approvers = [...new Set(approvals.map((entry) => entry.sessionId))];
    // Any valid rejection wins: a reviewer's "no" is never outvoted by other approvals.
    const decision = valid.some((entry) => entry.decision === "reject")
      ? "rejected"
      : approvers.length >= required
        ? "approved"
        : "pending";
    const risk = yield* decodeRisk({
      taskId: workflow.task.taskId,
      diffSha: evidence.diffSha,
      tier: classification.tier,
      policyVersion: ENTERPRISE_APPROVAL_POLICY_VERSION,
      matchedRules: classification.matchedRules,
      criticalChanges: classification.criticalChanges,
      approvers,
      // The decision lasts only as long as its earliest-expiring counted approval.
      expiresAt:
        approvals.length === 0 ? 0 : Math.min(...approvals.map((entry) => entry.expiresAt)),
      decision,
    }).pipe(Effect.mapError((cause) => fail("storage_failed", cause)));
    const blockers = getEnterpriseApprovalBlockers({
      task: workflow.task,
      evidence,
      risk,
      currentCommitSha: evidence.diffSha,
      currentPolicyVersion: ENTERPRISE_APPROVAL_POLICY_VERSION,
      nowEpochMillis: now,
    });
    return yield* decodeStatus({
      risk,
      evidence,
      blockers,
      requiredApprovers: required,
      ignored,
    }).pipe(Effect.mapError((cause) => fail("storage_failed", cause)));
  });

  const requireSession = (actor: EnterpriseApprover) =>
    isEnterpriseSessionAuthorized(sessions, actor.sessionId).pipe(
      Effect.flatMap((authorized) =>
        authorized ? Effect.void : Effect.fail(fail("authorization_required")),
      ),
    );

  const status = Effect.fn("EnterpriseApprovalService.status")(function* (
    raw: EnterpriseGetApprovalInput,
  ) {
    const input = yield* decodeGetInput(raw).pipe(Effect.mapError((c) => fail("invalid_input", c)));
    return yield* evaluate(input.workflow);
  });

  const record = Effect.fn("EnterpriseApprovalService.record")(function* (
    raw: EnterpriseRecordApprovalInput,
    approver: EnterpriseApprover,
  ) {
    const input = yield* decodeRecordInput(raw).pipe(
      Effect.mapError((c) => fail("invalid_input", c)),
    );
    yield* requireSession(approver);
    // Bind the decision to the commit the reviewer is actually looking at right now.
    const draft = yield* verified(input.workflow);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const minutes = input.validForMinutes ?? ENTERPRISE_APPROVAL_MAX_MINUTES;
    yield* workspace
      .appendApproval({
        ...scope(input.workflow),
        entry: {
          sessionId: approver.sessionId,
          subject: approver.subject,
          decision: input.decision,
          diffSha: draft.evidence.diffSha,
          policyVersion: ENTERPRISE_APPROVAL_POLICY_VERSION,
          decidedAt: now,
          expiresAt: now + minutes * 60_000,
        },
      })
      .pipe(Effect.mapError((cause) => fail("storage_failed", cause)));
    return yield* evaluate(input.workflow);
  });

  const mergeTask = Effect.fn("EnterpriseApprovalService.merge")(function* (
    raw: EnterpriseMergeTaskInput,
    requester: EnterpriseApprover,
  ) {
    const input = yield* decodeMergeInput(raw).pipe(
      Effect.mapError((c) => fail("invalid_input", c)),
    );
    yield* requireSession(requester);
    const current = yield* evaluate(input.workflow);
    if (current.blockers.length > 0)
      return yield* new EnterpriseApprovalError({ reason: "blocked", blockers: current.blockers });
    // The merge service re-checks the same blockers with its own clock and moves the branch by
    // compare-and-swap, so a target that moved since review is refused rather than overwritten.
    const merged = yield* merge
      .execute({
        repositoryRoot: input.workflow.repositoryRoot,
        targetRef: `refs/heads/${input.targetBranch}`,
        expectedTargetCommit: input.expectedTargetCommit,
        task: input.workflow.task,
        evidence: current.evidence,
        risk: current.risk,
        currentPolicyVersion: ENTERPRISE_APPROVAL_POLICY_VERSION,
      })
      .pipe(
        Effect.catchTags({
          EnterpriseMergeRejected: (rejected) =>
            Effect.fail(
              rejected.reason === "blocked"
                ? new EnterpriseApprovalError({
                    reason: "blocked",
                    ...(rejected.blockers ? { blockers: rejected.blockers } : {}),
                  })
                : rejected.reason === "invalid_commit"
                  ? fail("invalid_ref", rejected)
                  : fail(rejected.reason, rejected),
            ),
          EnterpriseMergeError: (cause) => Effect.fail(fail("merge_failed", cause)),
        }),
      );
    return yield* decodeMergeResult(merged).pipe(Effect.mapError((c) => fail("merge_failed", c)));
  });

  return EnterpriseApprovalService.of({ status, record, merge: mergeTask });
});

type EnterpriseApprovalStatusIgnored = EnterpriseApprovalStatus["ignored"][number]["reason"];

export const layer = Layer.effect(EnterpriseApprovalService, make).pipe(
  Layer.provide(Merge.layer),
  Layer.provide(Git.layer),
);
