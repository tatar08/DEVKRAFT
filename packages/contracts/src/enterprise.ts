import * as Schema from "effect/Schema";

import {
  AuthSessionId,
  CommandId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const Identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const EnterpriseTaskId = Identifier.pipe(Schema.brand("EnterpriseTaskId"));
export type EnterpriseTaskId = typeof EnterpriseTaskId.Type;

/** Git SHA-1 and SHA-256 repositories both need full immutable commit identities. */
const CommitSha = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(8192));
const ArtifactIds = Schema.Array(Identifier).check(Schema.isMaxLength(256));
const UniqueIdentifiers = Schema.Array(Identifier).check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (values) => new Set(values).size === values.length || "Identifiers must be distinct.",
  ),
);

export const EnterpriseTaskStage = Schema.Literals([
  "queued",
  "scoped",
  "running",
  "verifying",
  "awaiting_approval",
  "pr_opened",
  "completed",
  "retryable",
  "blocked",
  "cancel_requested",
  "terminated",
  "cleanup_verified",
]);
export type EnterpriseTaskStage = typeof EnterpriseTaskStage.Type;

/** Amounts use USD cents; unknown cost is null, never an invented zero. */
const Cents = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Budget = Schema.Struct({
  currency: Schema.Literal("USD"),
  limitCents: Cents.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const TaskSpec = Schema.Struct({
  taskId: EnterpriseTaskId,
  tenantId: Identifier,
  projectId: ProjectId,
  repoCommit: CommitSha,
  acceptanceCriteria: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  /** Empty grants no tools. Check executables use absolute paths; native Codex roles
   * require explicit codex.workspace_read / codex.workspace_write capabilities. */
  approvedTools: UniqueIdentifiers,
  budgetLimit: Budget,
});
export type TaskSpec = typeof TaskSpec.Type;

const CheckEvidence = Schema.Struct({
  name: Identifier,
  kind: Schema.Literals(["test", "lint", "typecheck", "security_scan"]),
  status: Schema.Literals(["passed", "failed", "not_run"]),
  commitSha: CommitSha,
  artifactIds: ArtifactIds,
}).check(
  Schema.makeFilter(
    (check) =>
      check.status === "not_run" ||
      check.artifactIds.length > 0 ||
      "Executed checks require evidence artifacts.",
  ),
);

export const AgentHandoff = Schema.Struct({
  taskId: EnterpriseTaskId,
  threadId: ThreadId,
  runId: RunId,
  modelId: ModelSelection,
  commitSha: CommitSha,
  inputArtifactIds: ArtifactIds,
  outputArtifactIds: ArtifactIds,
  testEvidence: Schema.Array(CheckEvidence).check(Schema.isMaxLength(256)),
  /** Bounded error categories, not raw logs or secrets. */
  errors: Schema.Array(Identifier).check(Schema.isMaxLength(100)),
});
export type AgentHandoff = typeof AgentHandoff.Type;

export const RiskDecision = Schema.Struct({
  taskId: EnterpriseTaskId,
  diffSha: CommitSha,
  tier: Schema.Literals([0, 1, 2]),
  policyVersion: Identifier,
  matchedRules: UniqueIdentifiers,
  criticalChanges: Schema.Array(
    Schema.Literals([
      "migration",
      "production_deploy",
      "permissions",
      "dependency_scripts",
      "auth",
      "billing",
      "secrets",
      "infrastructure",
      "network_policy",
    ]),
  ).check(Schema.isMaxLength(9)),
  approvers: UniqueIdentifiers,
  /** Unix epoch milliseconds; the server supplies the clock during revalidation. */
  expiresAt: NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  decision: Schema.Literals(["pending", "approved", "rejected"]),
}).check(
  Schema.makeFilter(
    (risk) =>
      ((risk.criticalChanges.length === 0 || risk.tier === 2) &&
        (risk.decision !== "approved" || risk.approvers.length >= (risk.tier === 2 ? 2 : 1))) ||
      "Approval requires distinct human approvers; critical changes require tier 2.",
  ),
);
export type RiskDecision = typeof RiskDecision.Type;

export const PullRequestEvidence = Schema.Struct({
  taskId: EnterpriseTaskId,
  diffSha: CommitSha,
  tests: Schema.Array(CheckEvidence).check(Schema.isMaxLength(256)),
  securityScan: CheckEvidence.check(
    Schema.makeFilter(
      (check) =>
        check.kind === "security_scan" || "A security scan must use the security_scan check kind.",
    ),
  ),
  screenshots: Schema.optionalKey(ArtifactIds),
  cost: Schema.Struct({
    currency: Schema.Literal("USD"),
    amountCents: Schema.NullOr(Cents),
  }),
  provenance: Schema.Struct({
    threadId: ThreadId,
    runId: RunId,
    commitSha: CommitSha,
    artifactIds: ArtifactIds,
  }),
});
export type PullRequestEvidence = typeof PullRequestEvidence.Type;

export const EnterpriseApprovalBlocker = Schema.Literals([
  "task_mismatch",
  "stale_diff",
  "checks_incomplete",
  "security_scan_incomplete",
  "cost_unknown",
  "budget_exceeded",
  "approval_required",
  "approval_expired",
  "policy_changed",
]);
export type EnterpriseApprovalBlocker = typeof EnterpriseApprovalBlocker.Type;

/** Pure evidence gate, not authorization. Callers must independently authenticate actors,
 * check destination-environment grants, and verify artifacts against the actual checkout. */
export function getEnterpriseApprovalBlockers(input: {
  readonly task: TaskSpec;
  readonly evidence: PullRequestEvidence;
  readonly risk: RiskDecision;
  readonly currentCommitSha: string;
  readonly currentPolicyVersion: string;
  readonly nowEpochMillis: number;
}): ReadonlyArray<EnterpriseApprovalBlocker> {
  const { task, evidence, risk } = input;
  const blockers: EnterpriseApprovalBlocker[] = [];
  if (evidence.taskId !== task.taskId || risk.taskId !== task.taskId)
    blockers.push("task_mismatch");
  if (
    evidence.diffSha !== input.currentCommitSha ||
    risk.diffSha !== input.currentCommitSha ||
    evidence.provenance.commitSha !== input.currentCommitSha ||
    [...evidence.tests, evidence.securityScan].some(
      (check) => check.commitSha !== input.currentCommitSha,
    )
  ) {
    blockers.push("stale_diff");
  }
  if (
    !evidence.tests.some((check) => check.kind === "test") ||
    evidence.tests.some((check) => check.status !== "passed")
  )
    blockers.push("checks_incomplete");
  if (evidence.securityScan.status !== "passed") blockers.push("security_scan_incomplete");
  if (evidence.cost.amountCents === null) blockers.push("cost_unknown");
  else if (evidence.cost.amountCents > task.budgetLimit.limitCents)
    blockers.push("budget_exceeded");
  if (risk.decision !== "approved") blockers.push("approval_required");
  if (
    !Number.isSafeInteger(input.nowEpochMillis) ||
    input.nowEpochMillis < 0 ||
    risk.expiresAt <= input.nowEpochMillis
  )
    blockers.push("approval_expired");
  if (risk.policyVersion !== input.currentPolicyVersion) blockers.push("policy_changed");
  return blockers;
}

/** Supervised role launches reuse V2; no separate execution ledger. */
export const EnterpriseRole = Schema.Literals(["architect", "coder", "qa"]);
export type EnterpriseRole = typeof EnterpriseRole.Type;
/** Revision zero is initial work; at most two supervised correction rounds. */
const EnterpriseRevision = Schema.optional(Schema.Literals([0, 1, 2]));
export const EnterpriseLaunchRoleInput = Schema.Struct({
  revision: EnterpriseRevision,
  task: TaskSpec,
  role: EnterpriseRole,
  modelSelection: ModelSelection,
  repositoryRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  workspacesRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  issueContext: Schema.String.check(Schema.isMaxLength(65536)),
});
export type EnterpriseLaunchRoleInput = typeof EnterpriseLaunchRoleInput.Type;
export const EnterpriseLaunchRoleResult = Schema.Struct({
  threadId: ThreadId,
  resumed: Schema.Boolean,
});
export class EnterpriseRoleError extends Schema.TaggedError<EnterpriseRoleError>()(
  "EnterpriseRoleError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "project_mismatch",
      "provider_unsupported",
      "tool_not_allowed",
      "workspace_in_use",
      "predecessor_incomplete",
      "predecessor_failed",
      "request_mismatch",
      "launch_failed",
      "invalid_output",
      "context_too_large",
      "authorization_required",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Enterprise role operation rejected: ${this.reason}.`;
  }
}

export const EnterpriseReleaseWorkspaceInput = Schema.Struct({
  task: TaskSpec,
  repositoryRoot: EnterpriseLaunchRoleInput.fields.repositoryRoot,
  workspacesRoot: EnterpriseLaunchRoleInput.fields.workspacesRoot,
});
export type EnterpriseReleaseWorkspaceInput = typeof EnterpriseReleaseWorkspaceInput.Type;

/** Resolve a completed role's authoritative V2 checkpoint, without trusting agent claims. */
export const EnterpriseCollectHandoffInput = Schema.Struct({
  ...EnterpriseReleaseWorkspaceInput.fields,
  role: EnterpriseLaunchRoleInput.fields.role,
  revision: EnterpriseRevision,
});
export type EnterpriseCollectHandoffInput = typeof EnterpriseCollectHandoffInput.Type;

export const EnterpriseCheck = Schema.Struct({
  kind: Schema.Literals(["test", "lint", "typecheck", "security_scan"]),
  name: Identifier,
  tool: Schema.String.check(Schema.isPattern(/^\/usr\/bin\/[a-zA-Z0-9._+-]+$/)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(Schema.isMaxLength(100)),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(120_000)),
});
export type EnterpriseCheck = typeof EnterpriseCheck.Type;
export const EnterpriseGatePlan = Schema.Array(EnterpriseCheck).check(
  Schema.isMinLength(4),
  Schema.isMaxLength(32),
  Schema.makeFilter(
    (checks) =>
      (["test", "lint", "typecheck", "security_scan"].every((kind) =>
        checks.some((check) => check.kind === kind),
      ) &&
        new Set(checks.map((check) => check.name)).size === checks.length) ||
      "Gate requires test, lint, typecheck and security scan with unique names.",
  ),
);
export const EnterpriseGateRoleInput = Schema.Struct({
  ...EnterpriseCollectHandoffInput.fields,
  role: Schema.Literal("coder"),
  plan: EnterpriseGatePlan,
});
export type EnterpriseGateRoleInput = typeof EnterpriseGateRoleInput.Type;
export const EnterpriseSnapshotGateResult = Schema.Struct({
  artifactId: Identifier,
  handoff: AgentHandoff,
}).check(
  Schema.makeFilter(
    (result) =>
      (result.handoff.outputArtifactIds.includes(result.artifactId) &&
        ["test", "lint", "typecheck", "security_scan"].every((kind) =>
          result.handoff.testEvidence.some((check) => check.kind === kind),
        ) &&
        result.handoff.testEvidence.every(
          (check) =>
            check.status === "passed" &&
            check.commitSha === result.handoff.commitSha &&
            check.artifactIds.includes(result.artifactId),
        )) ||
      "A successful snapshot gate requires passing checks at its checkpoint commit with linked artifacts.",
  ),
);
export type EnterpriseSnapshotGateResult = typeof EnterpriseSnapshotGateResult.Type;

/** Failed checks are recovery context, never passing evidence or approval. */
export const EnterpriseSnapshotGateFailure = Schema.Struct({
  artifactId: Identifier.check(Schema.isPattern(/^gate-failure-[a-f0-9]{64}\.json$/)),
  handoff: AgentHandoff,
  failedCheck: Schema.Struct({
    name: EnterpriseCheck.fields.name,
    kind: EnterpriseCheck.fields.kind,
  }),
  reason: Schema.Literal("check_failed"),
}).check(
  Schema.makeFilter(
    (failure) =>
      failure.handoff.testEvidence.length === 0 || "Failure cannot declare passing evidence.",
  ),
);
export type EnterpriseSnapshotGateFailure = typeof EnterpriseSnapshotGateFailure.Type;
export const EnterpriseGateAndContinueInput = Schema.Struct({
  ...EnterpriseLaunchRoleInput.fields,
  role: Schema.Literal("coder"),
  plan: EnterpriseGatePlan,
});
export type EnterpriseGateAndContinueInput = typeof EnterpriseGateAndContinueInput.Type;
export const EnterpriseGateAndContinueResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("passed"), gate: EnterpriseSnapshotGateResult }),
  Schema.Struct({
    status: Schema.Literal("fix_started"),
    failure: EnterpriseSnapshotGateFailure,
    launch: EnterpriseLaunchRoleResult,
  }),
  Schema.Struct({ status: Schema.Literal("blocked"), failure: EnterpriseSnapshotGateFailure }),
]);
export type EnterpriseGateAndContinueResult = typeof EnterpriseGateAndContinueResult.Type;

export const EnterpriseBuildPullRequestDraftInput = Schema.Struct({
  ...EnterpriseCollectHandoffInput.fields,
  role: Schema.Literal("coder"),
  artifactId: Identifier.check(
    Schema.isPattern(
      /^gate-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/,
    ),
  ),
});
export type EnterpriseBuildPullRequestDraftInput = typeof EnterpriseBuildPullRequestDraftInput.Type;
/** A report, never authorization to publish or merge. Unknown cost stays unknown. */
export const EnterprisePullRequestDraft = Schema.Struct({
  evidence: PullRequestEvidence,
  body: Schema.String.check(Schema.isMaxLength(65536)),
  approvalStatus: Schema.Literal("not_evaluated"),
});
export type EnterprisePullRequestDraft = typeof EnterprisePullRequestDraft.Type;

const RelativeRepositoryPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) =>
      (!/[\\:]/.test(value) &&
        !Array.from(value).some((char) => char.charCodeAt(0) < 32) &&
        value
          .split("/")
          .every(
            (part) => part !== "" && ![".", "..", ".git", ".codex", ".agents"].includes(part),
          )) ||
      "Expected a relative repository path outside control metadata.",
  ),
);
const CriterionIndex = NonNegativeInt.check(Schema.isLessThanOrEqualTo(99));
export const EnterpriseChangeSpec = Schema.Struct({
  kind: Schema.Literal("enterprise_spec"),
  taskId: EnterpriseTaskId,
  baseCommit: CommitSha,
  summary: Text,
  affectedPaths: Schema.Array(RelativeRepositoryPath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  acceptancePlan: Schema.Array(
    Schema.Struct({ criterionIndex: CriterionIndex, verification: Text }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  exclusions: Schema.Array(Text).check(Schema.isMaxLength(32)),
});
export const EnterpriseQaReport = Schema.Struct({
  kind: Schema.Literal("enterprise_qa"),
  taskId: EnterpriseTaskId,
  reviewedCommit: CommitSha,
  summary: Text,
  verdict: Schema.Literals(["pass", "request_changes"]),
  coveredCriteria: Schema.Array(CriterionIndex).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  findings: Schema.Array(
    Schema.Struct({
      severity: Schema.Literals(["blocker", "major", "minor"]),
      path: RelativeRepositoryPath,
      line: PositiveInt.check(Schema.isLessThanOrEqualTo(10_000_000)),
      description: Text,
      regressionTest: Text,
    }),
  ).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(
    (report) =>
      report.verdict !== "pass" ||
      !report.findings.some((finding) => finding.severity !== "minor") ||
      "A passing QA report cannot contain blocker or major findings.",
  ),
);
export const EnterpriseRoleOutput = Schema.Union([EnterpriseChangeSpec, EnterpriseQaReport]);
export type EnterpriseRoleOutput = typeof EnterpriseRoleOutput.Type;
export const EnterpriseCollectRoleArtifactInput = Schema.Struct({
  ...EnterpriseCollectHandoffInput.fields,
  role: Schema.Literals(["architect", "qa"]),
});
export type EnterpriseCollectRoleArtifactInput = typeof EnterpriseCollectRoleArtifactInput.Type;
export const EnterpriseRoleArtifact = Schema.Struct({
  artifactId: MessageId,
  handoff: AgentHandoff,
  output: EnterpriseRoleOutput,
}).check(
  Schema.makeFilter(
    (artifact) =>
      (artifact.output.taskId === artifact.handoff.taskId &&
        artifact.handoff.outputArtifactIds.includes(artifact.artifactId)) ||
      "A role artifact must reference its task and persisted output message.",
  ),
);
export type EnterpriseRoleArtifact = typeof EnterpriseRoleArtifact.Type;

/** Candidates are operator configuration; tier must match the local model namespace. */
export const EnterpriseRoutingCandidate = Schema.Struct({
  selection: ModelSelection,
  tier: Schema.Literals(["local", "cloud"]),
}).check(
  Schema.makeFilter(
    (candidate) =>
      (candidate.selection.instanceId === "codex" &&
        candidate.selection.model.startsWith("ollama/") === (candidate.tier === "local")) ||
      "Candidates must use the validated Codex harness; Ollama models use the local tier.",
  ),
);
export const EnterpriseWorkflowRouting = Schema.Struct({
  candidates: Schema.Array(EnterpriseRoutingCandidate).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.makeFilter(
      (values) =>
        new Set(values.map((value) => `${value.selection.instanceId}/${value.selection.model}`))
          .size === values.length || "Duplicate routing candidate.",
    ),
  ),
  /** Only a docs-only Architect spec can qualify the Coder for local execution. */
  preferLocalDocs: Schema.Boolean,
  allowCloudFallback: Schema.Boolean,
});

/** Reconcile one workflow step from V2 projections; no client-supplied stage. */
export const EnterpriseAdvanceWorkflowInput = Schema.Struct({
  ...EnterpriseReleaseWorkspaceInput.fields,
  modelSelection: EnterpriseLaunchRoleInput.fields.modelSelection,
  issueContext: EnterpriseLaunchRoleInput.fields.issueContext,
  plan: EnterpriseGatePlan,
  routing: Schema.optionalKey(EnterpriseWorkflowRouting),
});
export type EnterpriseAdvanceWorkflowInput = typeof EnterpriseAdvanceWorkflowInput.Type;
export const EnterpriseAdvanceWorkflowResult = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["running", "waiting_checkpoint"]),
    role: EnterpriseRole,
    revision: Schema.Literals([0, 1, 2]),
    threadId: ThreadId,
  }),
  Schema.Struct({
    state: Schema.Literal("blocked"),
    reason: Schema.Literals([
      "thread_closed",
      "failed_run",
      "unexpected_run",
      "checkpoint_unavailable",
      "corrections_exhausted",
      "budget_exceeded",
      "cost_unknown",
      "model_unavailable",
    ]),
  }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    revision: Schema.Literals([0, 1, 2]),
    draft: EnterprisePullRequestDraft,
  }),
]);
export type EnterpriseAdvanceWorkflowResult = typeof EnterpriseAdvanceWorkflowResult.Type;

/** Automation intent/configuration only; progress remains in V2. */
export const EnterpriseWorkflowAutomationRecord = Schema.Struct({
  version: Schema.Literal(1),
  input: EnterpriseAdvanceWorkflowInput,
  ownerSessionId: AuthSessionId,
  enabled: Schema.Boolean,
  stopReason: Schema.NullOr(
    Schema.Literals(["manual", "cancelled", "ready", "blocked", "authorization_required", "error"]),
  ),
});
export type EnterpriseWorkflowAutomationRecord = typeof EnterpriseWorkflowAutomationRecord.Type;
export const EnterpriseWorkflowAutomationStatus = Schema.Struct({
  registered: Schema.Boolean,
  enabled: Schema.Boolean,
  stopReason: EnterpriseWorkflowAutomationRecord.fields.stopReason,
});
export type EnterpriseWorkflowAutomationStatus = typeof EnterpriseWorkflowAutomationStatus.Type;
export const EnterpriseStartWorkflowResult = Schema.Struct({
  automation: EnterpriseWorkflowAutomationStatus,
  state: EnterpriseAdvanceWorkflowResult,
});
export type EnterpriseStartWorkflowResult = typeof EnterpriseStartWorkflowResult.Type;

/** Requests committed to V2; provider termination remains asynchronous. */
export const EnterpriseCancelWorkflowResult = Schema.Struct({
  automation: EnterpriseWorkflowAutomationStatus,
  stopRequests: Schema.Array(Schema.Struct({ threadId: ThreadId, commandId: CommandId })),
});
export type EnterpriseCancelWorkflowResult = typeof EnterpriseCancelWorkflowResult.Type;

/** Explicit publication of a verified workflow as a draft. Never grants merge approval. */
export const EnterprisePublishPullRequestInput = Schema.Struct({
  workflow: EnterpriseAdvanceWorkflowInput,
  repository: Schema.String.check(
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
  ),
  baseBranch: TrimmedNonEmptyString.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  ),
});
export type EnterprisePublishPullRequestInput = typeof EnterprisePublishPullRequestInput.Type;
export const EnterprisePublishedPullRequest = Schema.Struct({
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/),
  ),
  number: PositiveInt,
  commitSha: CommitSha,
  headBranch: TrimmedNonEmptyString,
  reconciled: Schema.Boolean,
});
export type EnterprisePublishedPullRequest = typeof EnterprisePublishedPullRequest.Type;
export class EnterprisePublicationError extends Schema.TaggedError<EnterprisePublicationError>()(
  "EnterprisePublicationError",
  {
    reason: Schema.Literals([
      "invalid_input",
      "workflow_not_ready",
      "busy",
      "request_mismatch",
      "remote_mismatch",
      "remote_failed",
      "publication_unknown",
      "unsafe_git_config",
      "storage_failed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Enterprise draft PR publication rejected: ${this.reason}.`;
  }
}

export const EnterpriseGithubIssueUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9][0-9]*$/,
  ),
);
const { issueContext: _issueContext, ...issueWorkflowFields } =
  EnterpriseAdvanceWorkflowInput.fields;
export const EnterpriseStartIssueWorkflowInput = Schema.Struct({
  workflow: Schema.Struct(issueWorkflowFields),
  issueUrl: EnterpriseGithubIssueUrl,
});
export type EnterpriseStartIssueWorkflowInput = typeof EnterpriseStartIssueWorkflowInput.Type;

/**
 * Every Enterprise RPC method, in one place so the RPC group, authorization and instrumentation
 * cannot drift apart.
 */
export const ENTERPRISE_WS_METHODS = {
  startIssueWorkflow: "enterprise.startIssueWorkflow",
  publishPullRequest: "enterprise.publishPullRequest",
  collectRoleArtifact: "enterprise.collectRoleArtifact",
  buildPullRequestDraft: "enterprise.buildPullRequestDraft",
  startWorkflow: "enterprise.startWorkflow",
  stopWorkflow: "enterprise.stopWorkflow",
  cancelWorkflow: "enterprise.cancelWorkflow",
  getWorkflowAutomation: "enterprise.getWorkflowAutomation",
  advanceWorkflow: "enterprise.advanceWorkflow",
  gateAndContinue: "enterprise.gateAndContinue",
  gateRole: "enterprise.gateRole",
  collectHandoff: "enterprise.collectHandoff",
  launchRole: "enterprise.launchRole",
  releaseWorkspace: "enterprise.releaseWorkspace",
} as const;
export type EnterpriseWsMethod = (typeof ENTERPRISE_WS_METHODS)[keyof typeof ENTERPRISE_WS_METHODS];
export const ENTERPRISE_WS_METHOD_LIST: ReadonlyArray<EnterpriseWsMethod> =
  Object.values(ENTERPRISE_WS_METHODS);
export const isEnterpriseWsMethod = (method: string): method is EnterpriseWsMethod =>
  (ENTERPRISE_WS_METHOD_LIST as ReadonlyArray<string>).includes(method);
