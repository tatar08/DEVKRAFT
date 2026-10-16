import {
  AgentHandoff,
  EnterpriseBuildPullRequestDraftInput,
  EnterpriseGatePlan,
  EnterpriseSnapshotGateFailure,
  EnterpriseSnapshotGateResult,
  EnterpriseWorkflowAutomationRecord,
  TaskSpec,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Sandbox from "./EnterpriseSandboxService.ts";

/** Validate the automation record before it becomes durable workspace state. */
export const encodeAutomation = Schema.encodeEffect(
  Schema.fromJsonString(EnterpriseWorkflowAutomationRecord),
);
/** Treat persisted automation as untrusted input on every read. */
export const decodeAutomation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EnterpriseWorkflowAutomationRecord),
);
/** Persist immutable task identity so retries cannot adopt an unrelated checkout. */
export const Ownership = Schema.Struct({
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
/** Validate caller-provided handoffs before trusting their task, thread and checkpoint. */
export const decodeHandoff = Schema.decodeUnknownEffect(AgentHandoff);
/** Validate the complete gate plan before running or comparing its checks. */
export const decodePlan = Schema.decodeUnknownEffect(EnterpriseGatePlan);
/** Validate generated gate evidence before persisting or returning it. */
export const decodeSnapshotResult = Schema.decodeUnknownEffect(EnterpriseSnapshotGateResult);
/** Validate the manifest before trusting any of its paths or bindings. */
export const decodeOwnership = Schema.decodeUnknownEffect(Schema.fromJsonString(Ownership));
/** Keep lifecycle writes in the same manifest format used for ownership validation. */
export const encodeOwnership = Schema.encodeEffect(Schema.fromJsonString(Ownership));
/** CLI task files receive the same contract validation as RPC task inputs. */
export const decodeSpecFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskSpec));
/** Validate CLI check files before passing commands to the sandbox. */
export const decodeCheckFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Sandbox.EnterpriseCheck),
);
/** Validate CLI gate files before any check executes. */
export const decodeGatePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(EnterpriseGatePlan));
/** Tie passing check output to the exact commit that was inspected. */
export const CheckArtifact = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["test", "lint", "typecheck", "security_scan"]),
  status: Schema.Literal("passed"),
  commitSha: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
});
/** Persist batch evidence with task identity so results retain their provenance. */
export const encodeGateArtifact = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      task: TaskSpec,
      commitSha: Schema.String,
      checks: Schema.Array(CheckArtifact),
    }),
  ),
);
/** Keep the handoff, plan and check evidence together for later consistency checks. */
const SnapshotArtifact = Schema.Struct({
  version: Schema.Literal(1),
  task: TaskSpec,
  result: EnterpriseSnapshotGateResult,
  plan: EnterpriseGatePlan,
  checks: Schema.Array(CheckArtifact),
});
/** Persist snapshot evidence in the format checked by later draft construction. */
export const encodeSnapshotArtifact = Schema.encodeEffect(Schema.fromJsonString(SnapshotArtifact));
/** Revalidate stored snapshot evidence before publication can rely on it. */
export const decodeSnapshotArtifact = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SnapshotArtifact),
);
/** Bind failures to their task and plan so retries cannot reuse unrelated evidence. */
const FailureArtifact = Schema.Struct({
  version: Schema.Literal(1),
  task: TaskSpec,
  result: EnterpriseSnapshotGateFailure,
  plan: EnterpriseGatePlan,
});
/** Persist failure evidence without granting it the authority of a passing gate. */
export const encodeFailureArtifact = Schema.encodeEffect(Schema.fromJsonString(FailureArtifact));
/** Revalidate failure records before using them to guide a workflow retry. */
export const decodeFailureArtifact = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FailureArtifact),
);
/** Use the original handoff and plan as the stable identity for failure retries. */
export const encodeFailureKey = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ handoff: AgentHandoff, plan: EnterpriseGatePlan })),
);
/** Serialize plans consistently when checking persisted redacted failure evidence. */
export const encodeFailurePlan = Schema.encodeEffect(Schema.fromJsonString(EnterpriseGatePlan));
/** Restrict artifact lookup to the contract-approved filename shape. */
export const decodeArtifactId = Schema.decodeUnknownEffect(
  EnterpriseBuildPullRequestDraftInput.fields.artifactId,
);
/** Compare handoffs through the contract representation rather than object identity. */
export const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(AgentHandoff));
/** Persist single-check evidence in its existing CLI artifact format. */
export const encodeCheckArtifact = Schema.encodeEffect(
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
/** Compare complete task identities through the same canonical contract encoding. */
export const encodeSpec = Schema.encodeEffect(Schema.fromJsonString(TaskSpec));

/** Bound persisted records and CLI inputs before parsing or writing to keep task state bounded. */
export const MAX_WORKSPACE_FILE_BYTES = 1_048_576;
