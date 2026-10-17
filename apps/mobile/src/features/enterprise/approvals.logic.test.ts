import { describe, expect, it } from "vite-plus/test";

import { awaitingApproval, blockerMessage, decisionReason } from "./approvals.logic";

describe("mobile approval inbox", () => {
  it("shows only awaiting approvals, preserving server order", () => {
    const first = { stage: "awaiting_approval" as const, id: "first" };
    const second = { stage: "awaiting_approval" as const, id: "second" };
    expect(
      awaitingApproval([
        first,
        { stage: "running" },
        second,
        { stage: "pr_opened" },
        { stage: "blocked" },
      ]),
    ).toEqual([first, second]);
  });
  it("keeps cached evidence read-only offline regardless of permissions", () => {
    expect(decisionReason(false, true, false, true)).toContain("live connection");
    expect(decisionReason(false, false, true, false)).toContain("live connection");
  });
  it("requires permission, fresh evidence and no pending command", () => {
    expect(decisionReason(true, false, false, true)).toContain("permission");
    expect(decisionReason(true, true, false, false)).toContain("verified evidence");
    expect(decisionReason(true, true, true, true)).toContain("in progress");
    expect(decisionReason(true, true, false, true)).toBeNull();
  });
  it("explains approval and stale evidence blockers", () => {
    expect(blockerMessage.approval_required).toContain("human approvals");
    expect(blockerMessage.stale_diff).toContain("changes have moved");
  });
});
