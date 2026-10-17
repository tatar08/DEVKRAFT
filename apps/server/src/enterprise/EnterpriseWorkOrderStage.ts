import type {
  EnterpriseRole,
  EnterpriseWorkflowAutomationRecord,
  EnterpriseWorkOrderStage,
  ThreadId,
} from "@t3tools/contracts";
import type { EnterpriseRevision } from "./EnterpriseRun.ts";

/** The latest initial/retry run of one role thread, as V2 reports it. */
export interface EnterpriseRoleRunSummary {
  readonly role: EnterpriseRole;
  readonly revision: EnterpriseRevision;
  readonly threadId: ThreadId;
  readonly status: string;
}

const TERMINAL_FAILURES = new Set(["failed", "cancelled", "interrupted", "rolled_back"]);
const STOPPED_BLOCKED = new Set(["blocked", "error", "authorization_required", "cancelled"]);
const ROLE_ORDER: Record<EnterpriseRole, number> = { architect: 0, coder: 1, qa: 2 };

/**
 * Maps persisted state to a cockpit column. Order matters: an opened PR and a terminal stop are
 * facts that outrank whatever a role thread last reported; otherwise the most recent role decides.
 * This is presentation only. It never drives a transition, so a wrong column cannot cause work.
 */
export const deriveEnterpriseWorkOrderStage = (input: {
  readonly record: Pick<EnterpriseWorkflowAutomationRecord, "enabled" | "stopReason">;
  readonly runs: ReadonlyArray<EnterpriseRoleRunSummary>;
  readonly pullRequestOpened: boolean;
}): {
  readonly stage: EnterpriseWorkOrderStage;
  readonly activeRole: EnterpriseRoleRunSummary | null;
} => {
  const latest =
    input.runs
      .toSorted((a, b) => a.revision - b.revision || ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
      .at(-1) ?? null;
  if (input.pullRequestOpened) return { stage: "pr_opened", activeRole: null };
  if (
    (input.record.stopReason !== null && STOPPED_BLOCKED.has(input.record.stopReason)) ||
    input.runs.some((run) => TERMINAL_FAILURES.has(run.status))
  )
    return { stage: "blocked", activeRole: latest };
  if (input.record.stopReason === "ready") return { stage: "awaiting_approval", activeRole: null };
  if (latest === null) return { stage: "queued", activeRole: null };
  if (latest.status !== "completed") return { stage: "running", activeRole: latest };
  // A completed QA review is followed by the deterministic gate; earlier roles hand to the next.
  return latest.role === "qa"
    ? { stage: "verifying", activeRole: null }
    : { stage: "running", activeRole: latest };
};
