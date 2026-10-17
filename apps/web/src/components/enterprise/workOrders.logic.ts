import { ThreadId, type EnterpriseWorkOrder } from "@t3tools/contracts";
import type { EnterpriseApprovalBlocker, EnterpriseMergeCheckResult } from "@t3tools/contracts";

/** Server stages keep their order even when a column has no tasks. */
export const workOrderColumns = [
  ["queued", "Queued"],
  ["running", "Running"],
  ["verifying", "Verifying"],
  ["awaiting_approval", "Awaiting Approval"],
  ["pr_opened", "PR Opened"],
  ["blocked", "Blocked"],
] as const;

/** Explain the gate without requiring an operator to know protocol codes. */
export const blockerMessage: Record<EnterpriseApprovalBlocker, string> = {
  task_mismatch: "Evidence belongs to a different task.",
  stale_diff: "The changes have moved since this evidence was collected.",
  checks_incomplete: "Required checks have not all passed.",
  security_scan_incomplete: "The security scan has not passed.",
  cost_unknown: "The cost is unknown.",
  budget_exceeded: "The task exceeded its budget.",
  approval_required: "More human approvals are required, or the changes were rejected.",
  approval_expired: "Approval has expired.",
  policy_changed: "The approval policy has changed.",
};

const MERGE_CHECK_MAX_AGE_MS = 60_000;

/** A merge check is usable only for the branch and verified commit it actually checked. */
export function mergeCheckMatches(
  check: EnterpriseMergeCheckResult | null,
  branch: string,
  commit: string | undefined,
  checkedAt: number | undefined,
  now = Date.now(),
) {
  return (
    checkedAt !== undefined &&
    now >= checkedAt &&
    now - checkedAt < MERGE_CHECK_MAX_AGE_MS &&
    check !== null &&
    check.targetBranch === branch &&
    check.taskCommit === commit
  );
}

/** List refreshes supply the clock; cards need no individual timers. */
export function relativeUpdatedAt(value: string | null, now = Date.now()) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Update time unknown";
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  if (minutes < 1440) return `Updated ${Math.floor(minutes / 60)}h ago`;
  return `Updated ${Math.floor(minutes / 1440)}d ago`;
}

/** Ready orders omit activeRole; evidence identifies the verified Coder correction round. */
export function coderTarget(
  order: Pick<EnterpriseWorkOrder, "key" | "activeRole">,
  evidenceThreadId?: string,
) {
  const active = order.activeRole;
  if (active && active.role !== "architect") {
    return {
      threadId: ThreadId.make(active.threadId.replace(/:(coder|qa)$/, ":coder")),
      revision: active.revision,
    };
  }
  const prefix = `enterprise:${order.key}:`;
  if (evidenceThreadId === `${prefix}coder`)
    return { threadId: ThreadId.make(evidenceThreadId), revision: 0 as const };
  if (evidenceThreadId === `${prefix}fix1:coder`)
    return { threadId: ThreadId.make(evidenceThreadId), revision: 1 as const };
  if (evidenceThreadId === `${prefix}fix2:coder`)
    return { threadId: ThreadId.make(evidenceThreadId), revision: 2 as const };
  return null;
}
