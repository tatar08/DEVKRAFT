import { EnterpriseSnapshotGateFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Stable rejection reasons let callers fail closed without inspecting lower-level errors. */
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
/** Preserve the underlying failure without exposing host details in the user-facing message. */
export class EnterpriseWorkspaceError extends Schema.TaggedError<EnterpriseWorkspaceError>()(
  "EnterpriseWorkspaceError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Enterprise workspace operation failed.";
  }
}
