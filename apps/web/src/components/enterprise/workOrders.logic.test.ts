import {
  EnterpriseApprovalError,
  EnterpriseMergeCheckError,
  EnterprisePublicationError,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  actionErrorMessage,
  blockerMessage,
  coderTarget,
  mergeCheckMatches,
  relativeUpdatedAt,
  workOrderColumns,
} from "./workOrders.logic";
import type { EnterpriseMergeCheckResult } from "@t3tools/contracts";

const check: EnterpriseMergeCheckResult = {
  targetBranch: "main",
  targetCommit: "a".repeat(40),
  taskCommit: "b".repeat(40),
  treeSha: "c".repeat(40),
};

describe("cockpit operator decisions", () => {
  it("requires a fresh merge check for the exact branch and evidence", () => {
    expect(mergeCheckMatches(check, "main", check.taskCommit, 1000, 2000)).toBe(true);
    expect(mergeCheckMatches(check, "release", check.taskCommit, 1000, 2000)).toBe(false);
    expect(mergeCheckMatches(check, "main", "d".repeat(40), 1000, 2000)).toBe(false);
    expect(mergeCheckMatches(null, "main", check.taskCommit, 1000, 2000)).toBe(false);
    expect(mergeCheckMatches(check, "main", undefined, 1000, 2000)).toBe(false);
    expect(mergeCheckMatches(check, "main", check.taskCommit, undefined, 2000)).toBe(false);
    expect(mergeCheckMatches(check, "main", check.taskCommit, 1000, 61_000)).toBe(false);
    expect(mergeCheckMatches(check, "main", check.taskCommit, 3000, 2000)).toBe(false);
  });
  it("explains approval and stale evidence blockers", () => {
    expect(blockerMessage.approval_required).toContain("human approvals");
    expect(blockerMessage.stale_diff).toContain("changes have moved");
    expect(Object.values(blockerMessage).every((message) => message.endsWith("."))).toBe(true);
  });
  it("keeps all six columns in workflow order", () => {
    expect(workOrderColumns.map(([stage]) => stage)).toEqual([
      "queued",
      "running",
      "verifying",
      "awaiting_approval",
      "pr_opened",
      "blocked",
    ]);
  });
  it("handles missing and future update times without misleading ages", () => {
    expect(relativeUpdatedAt(null)).toBe("Update time unknown");
    expect(relativeUpdatedAt("invalid")).toBe("Update time unknown");
    expect(relativeUpdatedAt("2026-10-17T00:00:00Z", Date.parse("2026-10-17T00:05:00Z"))).toBe(
      "Updated 5m ago",
    );
    expect(relativeUpdatedAt("2026-10-18T00:00:00Z", Date.parse("2026-10-17T00:05:00Z"))).toBe(
      "Updated just now",
    );
  });
});

describe("Coder checkout selection", () => {
  const key = "a".repeat(64);
  it("preserves the verified correction round when activeRole is absent", () => {
    expect(coderTarget({ key, activeRole: null }, `enterprise:${key}:fix2:coder`)?.revision).toBe(
      2,
    );
    expect(coderTarget({ key, activeRole: null }, `enterprise:${key}:coder`)?.revision).toBe(0);
  });
  it("refuses evidence for another task or a QA thread", () => {
    expect(coderTarget({ key, activeRole: null }, `enterprise:${"b".repeat(64)}:coder`)).toBeNull();
    expect(coderTarget({ key, activeRole: null }, `enterprise:${key}:qa`)).toBeNull();
    expect(coderTarget({ key, activeRole: null })).toBeNull();
  });
});

describe("action error guidance", () => {
  it.each([
    [
      new EnterprisePublicationError({
        reason: "unsafe_git_config",
        cause: new Error("private diagnostic"),
      }),
      "Repository-local Git URL/credential settings are not allowed.",
    ],
    [
      new EnterprisePublicationError({
        reason: "remote_mismatch",
        cause: new Error("private diagnostic"),
      }),
      "A different branch or PR already exists for this task.",
    ],
    [
      new EnterprisePublicationError({
        reason: "publication_unknown",
        cause: new Error("private diagnostic"),
      }),
      "A previous publish may have succeeded; check GitHub before retrying.",
    ],
    [
      new EnterpriseApprovalError({
        reason: "target_moved",
        cause: new Error("private diagnostic"),
      }),
      "The target branch moved. Run Check merge again.",
    ],
    [
      new EnterpriseMergeCheckError({ reason: "conflict", cause: new Error("private diagnostic") }),
      "The changes conflict with the target branch.",
    ],
    [
      new EnterpriseApprovalError({ reason: "conflict", cause: new Error("private diagnostic") }),
      "The changes conflict with the target branch.",
    ],
    [
      new EnterprisePublicationError({ reason: "busy", cause: new Error("private diagnostic") }),
      "Another operation is running. Try again in a moment.",
    ],
    [
      new EnterpriseApprovalError({ reason: "busy", cause: new Error("private diagnostic") }),
      "Another operation is running. Try again in a moment.",
    ],
    [
      new EnterpriseMergeCheckError({ reason: "busy", cause: new Error("private diagnostic") }),
      "Another operation is running. Try again in a moment.",
    ],
  ])("explains %s without exposing causes", (error, message) => {
    expect(actionErrorMessage(error)).toBe(message);
  });

  it.each([
    null,
    new Error("private diagnostic"),
    { _tag: "UnrecognizedError", reason: "busy", cause: "private diagnostic" },
    { _tag: "EnterprisePublicationError", reason: "future_reason", cause: "private diagnostic" },
    { reason: "unsafe_git_config" },
  ])("uses safe fallback guidance for unknown errors", (error) => {
    expect(actionErrorMessage(error)).toBe("The action failed. Refresh evidence before retrying.");
  });
});
