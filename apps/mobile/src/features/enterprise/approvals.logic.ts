import type { EnterpriseApprovalBlocker, EnterpriseWorkOrder } from "@t3tools/contracts";

/** Keep cached orders visible without presenting other workflow stages as actionable. */
export function awaitingApproval<T extends Pick<EnterpriseWorkOrder, "stage">>(
  orders: readonly T[],
) {
  return orders.filter((order) => order.stage === "awaiting_approval");
}

/** Offline decisions must never look acknowledged or enter a deferred write queue. */
export function decisionReason(
  connected: boolean,
  permitted: boolean,
  busy: boolean,
  verified: boolean,
) {
  if (!connected) return "Environment disconnected. Decisions require a live connection.";
  if (!permitted) return "Approval permission is required.";
  if (busy) return "An action is in progress.";
  if (!verified) return "Refresh to load verified evidence.";
  return null;
}

/** Explain gate failures using the same operator language as the web cockpit. */
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

/** Explain why a stored decision is excluded from the current count. */
export const ignoredMessage = {
  stale_diff: "The verified changes have changed.",
  policy_changed: "The policy has changed.",
  expired: "The decision expired.",
  session_invalid: "The deciding session is no longer valid.",
};
