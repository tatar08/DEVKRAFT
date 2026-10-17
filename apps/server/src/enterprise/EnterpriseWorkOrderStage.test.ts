import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import {
  deriveEnterpriseWorkOrderStage,
  type EnterpriseRoleRunSummary,
} from "./EnterpriseWorkOrderStage.ts";

const run = (
  role: EnterpriseRoleRunSummary["role"],
  status: string,
  revision: EnterpriseRoleRunSummary["revision"] = 0,
): EnterpriseRoleRunSummary => ({
  role,
  revision,
  status,
  threadId: ThreadId.make(
    `enterprise:${"a".repeat(64)}:${revision ? `fix${revision}:` : ""}${role}`,
  ),
});
const enabled = { enabled: true, stopReason: null } as const;
const stage = (
  runs: ReadonlyArray<EnterpriseRoleRunSummary>,
  record: {
    enabled: boolean;
    stopReason: typeof enabled.stopReason | "ready" | "blocked" | "cancelled" | "manual";
  } = enabled,
  pullRequestOpened = false,
) => deriveEnterpriseWorkOrderStage({ record, runs, pullRequestOpened });

describe("deriveEnterpriseWorkOrderStage", () => {
  it("queues a registered workflow before any role runs", () => {
    assert.equal(stage([]).stage, "queued");
  });

  it("shows the most recent role as running, including correction rounds", () => {
    const result = stage([run("architect", "completed"), run("coder", "running")]);
    assert.equal(result.stage, "running");
    assert.equal(result.activeRole?.role, "coder");
    const fix = stage([
      run("architect", "completed"),
      run("coder", "completed"),
      run("qa", "completed"),
      run("coder", "running", 1),
    ]);
    assert.equal(fix.activeRole?.revision, 1);
  });

  it("treats a completed QA review as verifying (the deterministic gate is next)", () => {
    const result = stage([
      run("architect", "completed"),
      run("coder", "completed"),
      run("qa", "completed"),
    ]);
    assert.equal(result.stage, "verifying");
  });

  it("awaits approval once the verified draft is ready", () => {
    assert.equal(
      stage([run("qa", "completed")], { enabled: false, stopReason: "ready" }).stage,
      "awaiting_approval",
    );
  });

  it("puts failures and terminal stops in blocked, but an opened PR outranks everything", () => {
    assert.equal(stage([run("coder", "failed")]).stage, "blocked");
    assert.equal(stage([], { enabled: false, stopReason: "cancelled" }).stage, "blocked");
    assert.equal(stage([run("coder", "failed")], enabled, true).stage, "pr_opened");
  });
});
