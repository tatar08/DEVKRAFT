import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AgentHandoff,
  EnterpriseGatePlan,
  EnterpriseAdvanceWorkflowInput,
  EnterpriseAdvanceWorkflowResult,
  EnterpriseLaunchRoleInput,
  EnterpriseCollectHandoffInput,
  EnterpriseRoleArtifact,
  EnterpriseBuildPullRequestDraftInput,
  EnterpriseSnapshotGateResult,
  EnterpriseSnapshotGateFailure,
  EnterpriseTaskStage,
  PullRequestEvidence,
  RiskDecision,
  TaskSpec,
  getEnterpriseApprovalBlockers,
} from "./enterprise.ts";

const decodeWorkflowInput = Schema.decodeUnknownSync(EnterpriseAdvanceWorkflowInput);
const decodeWorkflowResult = Schema.decodeUnknownSync(EnterpriseAdvanceWorkflowResult);
const decodeGateFailure = Schema.decodeUnknownSync(EnterpriseSnapshotGateFailure);
const decodeRoleLaunch = Schema.decodeUnknownSync(EnterpriseLaunchRoleInput);
const decodeRoleHandoffInput = Schema.decodeUnknownSync(EnterpriseCollectHandoffInput);
const decodeRoleArtifact = Schema.decodeUnknownSync(EnterpriseRoleArtifact);
const decodeDraftArtifactId = Schema.decodeUnknownSync(
  EnterpriseBuildPullRequestDraftInput.fields.artifactId,
);
const decodeGatePlan = Schema.decodeUnknownSync(EnterpriseGatePlan);
const decodeSnapshotGateResult = Schema.decodeUnknownSync(EnterpriseSnapshotGateResult);
const decodeTaskSpec = Schema.decodeUnknownSync(TaskSpec);
const decodeAgentHandoff = Schema.decodeUnknownSync(AgentHandoff);
const decodeRiskDecision = Schema.decodeUnknownSync(RiskDecision);
const decodePullRequestEvidence = Schema.decodeUnknownSync(PullRequestEvidence);
const decodeEnterpriseTaskStage = Schema.decodeUnknownSync(EnterpriseTaskStage);
const encodeTaskSpec = Schema.encodeSync(TaskSpec);
const encodeAgentHandoff = Schema.encodeSync(AgentHandoff);
const encodeRiskDecision = Schema.encodeSync(RiskDecision);
const encodePullRequestEvidence = Schema.encodeSync(PullRequestEvidence);

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const taskInput = {
  taskId: "task:1",
  tenantId: "local",
  projectId: "project:1",
  repoCommit: commit,
  acceptanceCriteria: ["Regression test passes"],
  approvedTools: ["git.read"],
  budgetLimit: { currency: "USD", limitCents: 150 },
};
const check = {
  name: "regression",
  kind: "test",
  status: "passed",
  commitSha: commit,
  artifactIds: ["artifact:tests"],
} as const;
const evidenceInput = {
  taskId: "task:1",
  diffSha: commit,
  tests: [check],
  securityScan: { ...check, name: "security", kind: "security_scan" },
  cost: { currency: "USD", amountCents: 100 },
  provenance: {
    threadId: "thread:1",
    runId: "run:1",
    commitSha: commit,
    artifactIds: ["artifact:diff"],
  },
};
const riskInput = {
  taskId: "task:1",
  diffSha: commit,
  tier: 0,
  policyVersion: "policy:1",
  matchedRules: [],
  criticalChanges: [],
  approvers: ["actor:reviewer"],
  expiresAt: 2000,
  decision: "approved",
};
const task = decodeTaskSpec(taskInput);
const evidence = decodePullRequestEvidence(evidenceInput);
const risk = decodeRiskDecision(riskInput);
const gate = {
  task,
  evidence,
  risk,
  currentCommitSha: commit,
  currentPolicyVersion: "policy:1",
  nowEpochMillis: 1000,
};

function rejects(decode: (input: unknown) => unknown, input: unknown) {
  assert.throws(() => decode(input));
}

describe("enterprise contracts", () => {
  it("round-trips task, handoff, risk and evidence while preserving V2 identities", () => {
    const handoff = decodeAgentHandoff({
      taskId: task.taskId,
      threadId: "thread:1",
      runId: "run:1",
      modelId: { instanceId: "codex", model: "model:1" },
      commitSha: commit,
      inputArtifactIds: [],
      outputArtifactIds: ["artifact:diff"],
      testEvidence: [check],
      errors: [],
    });
    assert.equal(handoff.runId, evidence.provenance.runId);
    assert.deepEqual(decodeTaskSpec(encodeTaskSpec(task)), task);
    assert.deepEqual(decodeAgentHandoff(encodeAgentHandoff(handoff)), handoff);
    assert.deepEqual(decodeRiskDecision(encodeRiskDecision(risk)), risk);
    assert.deepEqual(decodePullRequestEvidence(encodePullRequestEvidence(evidence)), evidence);
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid budget %s",
    (limitCents) => {
      rejects(decodeTaskSpec, { ...taskInput, budgetLimit: { currency: "USD", limitCents } });
    },
  );
  it("requires acceptance criteria and full commit identity", () => {
    rejects(decodeTaskSpec, { ...taskInput, acceptanceCriteria: [] });
    rejects(decodeTaskSpec, { ...taskInput, acceptanceCriteria: ["  "] });
    rejects(decodeTaskSpec, { ...taskInput, repoCommit: "abc1234" });
    assert.equal(
      decodeTaskSpec({ ...taskInput, repoCommit: "a".repeat(64) }).repoCommit.length,
      64,
    );
  });
  it("keeps an empty tool allowlist and rejects duplicates", () => {
    assert.deepEqual(decodeTaskSpec({ ...taskInput, approvedTools: [] }).approvedTools, []);
    rejects(decodeTaskSpec, { ...taskInput, approvedTools: ["git.read", "git.read"] });
  });
  it("requires evidence for executed checks and a correctly typed security scan", () => {
    rejects(decodePullRequestEvidence, {
      ...evidenceInput,
      tests: [{ ...check, artifactIds: [] }],
    });
    rejects(decodePullRequestEvidence, { ...evidenceInput, securityScan: check });
  });
  it("requires manual approval even for tier 0", () => {
    rejects(decodeRiskDecision, { ...riskInput, approvers: [] });
    rejects(decodeRiskDecision, { ...riskInput, tier: 2 });
    rejects(decodeRiskDecision, { ...riskInput, tier: 2, approvers: ["actor:one", "actor:one"] });
    assert.equal(
      decodeRiskDecision({
        ...riskInput,
        tier: 2,
        approvers: ["actor:one", "actor:two"],
      }).approvers.length,
      2,
    );
  });
  it("prevents critical changes from being classified as tier 0", () => {
    rejects(decodeRiskDecision, { ...riskInput, criticalChanges: ["migration"] });
    assert.equal(
      decodeRiskDecision({
        ...riskInput,
        tier: 2,
        criticalChanges: ["migration"],
        approvers: ["actor:one", "actor:two"],
      }).tier,
      2,
    );
  });
  it("allows pending decisions and rejects unknown task stages", () => {
    assert.equal(
      decodeRiskDecision({ ...riskInput, decision: "pending", approvers: [] }).decision,
      "pending",
    );
    rejects(decodeEnterpriseTaskStage, "auto_deployed");
  });
});

describe("enterprise evidence gate", () => {
  it("accepts passing current evidence within budget with a current human decision", () => {
    assert.deepEqual(getEnterpriseApprovalBlockers(gate), []);
  });
  it("blocks mismatched tasks and changed diffs", () => {
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: {
          ...evidence,
          taskId: decodeTaskSpec({ ...taskInput, taskId: "task:other" }).taskId,
        },
      }),
      "task_mismatch",
    );
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, currentCommitSha: otherCommit }),
      "stale_diff",
    );
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, risk: { ...risk, diffSha: otherCommit } }),
      "stale_diff",
    );
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, tests: [{ ...evidence.tests[0]!, commitSha: otherCommit }] },
      }),
      "stale_diff",
    );
  });
  it.each(["failed", "not_run"] as const)("blocks %s checks", (status) => {
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, tests: [{ ...evidence.tests[0]!, status }] },
      }),
      "checks_incomplete",
    );
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, securityScan: { ...evidence.securityScan, status } },
      }),
      "security_scan_incomplete",
    );
  });
  it("does not treat lint-only evidence as a passing test suite", () => {
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, evidence: { ...evidence, tests: [] } }),
      "checks_incomplete",
    );
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, tests: [{ ...evidence.tests[0]!, kind: "lint" }] },
      }),
      "checks_incomplete",
    );
  });
  it("blocks unknown cost and budget overruns but allows the exact cap", () => {
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, cost: { currency: "USD", amountCents: null } },
      }),
      "cost_unknown",
    );
    assert.include(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, cost: { currency: "USD", amountCents: 151 } },
      }),
      "budget_exceeded",
    );
    assert.deepEqual(
      getEnterpriseApprovalBlockers({
        ...gate,
        evidence: { ...evidence, cost: { currency: "USD", amountCents: 150 } },
      }),
      [],
    );
  });
  it.each(["pending", "rejected"] as const)("blocks a %s decision", (decision) => {
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, risk: { ...risk, decision } }),
      "approval_required",
    );
  });
  it("revalidates expiry and policy after reconnect", () => {
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, nowEpochMillis: 2000 }),
      "approval_expired",
    );
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, nowEpochMillis: NaN }),
      "approval_expired",
    );
    assert.include(
      getEnterpriseApprovalBlockers({ ...gate, currentPolicyVersion: "policy:2" }),
      "policy_changed",
    );
  });
});

describe("Checkpoint gate contracts", () => {
  const plan = ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
    kind,
    name: kind,
    tool: "/usr/bin/true",
    args: [],
    timeoutMs: 1000,
  }));
  const artifactId = "gate:1";
  const result = {
    artifactId,
    handoff: {
      taskId: "task:1",
      threadId: "thread:1",
      runId: "run:1",
      modelId: { instanceId: "codex", model: "model:1" },
      commitSha: commit,
      inputArtifactIds: [],
      outputArtifactIds: ["checkpoint:1", artifactId],
      errors: [],
      testEvidence: plan.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        status: "passed",
        commitSha: commit,
        artifactIds: [artifactId],
      })),
    },
  };
  it("requires all four check kinds with distinct names and bounded commands", () => {
    assert.lengthOf(decodeGatePlan(plan), 4);
    rejects(decodeGatePlan, plan.slice(0, 3));
    rejects(
      decodeGatePlan,
      plan.map((entry) => ({ ...entry, name: "same" })),
    );
    rejects(
      decodeGatePlan,
      plan.map((entry) => ({ ...entry, tool: "node" })),
    );
    rejects(
      decodeGatePlan,
      plan.map((entry) => ({ ...entry, timeoutMs: 120001 })),
    );
  });
  it("accepts linked evidence and rejects a successful result missing passing evidence", () => {
    assert.equal(decodeSnapshotGateResult(result).handoff.commitSha, commit);
    rejects(decodeSnapshotGateResult, {
      ...result,
      handoff: { ...result.handoff, testEvidence: [] },
    });
    rejects(decodeSnapshotGateResult, {
      ...result,
      handoff: { ...result.handoff, outputArtifactIds: [] },
    });
  });
  it.each(["failed", "not_run", "other_commit", "other_artifact"])(
    "rejects %s evidence in a successful result",
    (change) => {
      rejects(decodeSnapshotGateResult, {
        ...result,
        handoff: {
          ...result.handoff,
          testEvidence: result.handoff.testEvidence.map((entry) => ({
            ...entry,
            ...(change === "other_commit"
              ? { commitSha: otherCommit }
              : change === "other_artifact"
                ? { artifactIds: ["artifact:other"] }
                : { status: change }),
          })),
        },
      });
    },
  );
});

it.each([
  "../gate.json",
  "/tmp/gate.json",
  "gate-declared.json",
  "gate-00000000-0000-0000-0000-000000000000.json",
])("rejects an unscoped draft artifact ID %s", (artifactId) => {
  rejects(decodeDraftArtifactId, artifactId);
});

describe("Structured artifact provenance", () => {
  const artifact = {
    artifactId: "message:structured",
    handoff: {
      taskId: "task:1",
      threadId: "thread:1",
      runId: "run:1",
      modelId: { instanceId: "codex", model: "model:1" },
      commitSha: commit,
      inputArtifactIds: [],
      outputArtifactIds: ["checkpoint:1", "message:structured"],
      testEvidence: [],
      errors: [],
    },
    output: {
      kind: "enterprise_spec",
      taskId: "task:1",
      baseCommit: commit,
      summary: "Atomic change",
      affectedPaths: ["src/api.ts"],
      acceptancePlan: [{ criterionIndex: 0, verification: "Scoped test" }],
      exclusions: [],
    },
  };
  it("links the structured output to its persisted message", () => {
    assert.equal(decodeRoleArtifact(artifact).artifactId, "message:structured");
  });
  it("rejects a foreign task in an otherwise valid output", () => {
    rejects(decodeRoleArtifact, {
      ...artifact,
      output: { ...artifact.output, taskId: "task:other" },
    });
  });
  it("rejects an unlinked output message", () => {
    rejects(decodeRoleArtifact, {
      ...artifact,
      handoff: { ...artifact.handoff, outputArtifactIds: ["checkpoint:1"] },
    });
  });
});

describe("Bounded role revisions", () => {
  const input = {
    task: taskInput,
    role: "coder",
    modelSelection: { instanceId: "codex", model: "model:1" },
    repositoryRoot: "/repo",
    workspacesRoot: "/tasks",
    issueContext: "Issue",
  };
  it("preserves initial compatibility and permits only two correction rounds", () => {
    assert.equal(decodeRoleLaunch(input).revision, undefined);
    for (const revision of [0, 1, 2]) {
      assert.equal(decodeRoleLaunch({ ...input, revision }).revision, revision);
      assert.equal(decodeRoleHandoffInput({ ...input, revision }).revision, revision);
    }
  });
  it.each([-1, 3, 100, 1.5, "1", null])(
    "rejects invalid revision %s on launch and handoff",
    (revision) => {
      rejects(decodeRoleLaunch, { ...input, revision });
      rejects(decodeRoleHandoffInput, { ...input, revision });
    },
  );
});

describe("Gate failure evidence boundary", () => {
  const failure = {
    artifactId: `gate-failure-${"a".repeat(64)}.json`,
    reason: "check_failed",
    failedCheck: { name: "unit", kind: "test" },
    handoff: {
      taskId: "task:1",
      threadId: "thread:1",
      runId: "run:1",
      modelId: { instanceId: "codex", model: "model:1" },
      commitSha: commit,
      inputArtifactIds: [],
      outputArtifactIds: ["checkpoint:1"],
      testEvidence: [],
      errors: [],
    },
  };
  it("accepts failed check identity with its source snapshot", () => {
    assert.equal(decodeGateFailure(failure).handoff.commitSha, commit);
  });
  it("rejects passing evidence or an arbitrary file path in failure context", () => {
    rejects(decodeGateFailure, { ...failure, artifactId: "../failure.json" });
    rejects(decodeGateFailure, {
      ...failure,
      handoff: {
        ...failure.handoff,
        testEvidence: [
          {
            name: "unit",
            kind: "test",
            status: "passed",
            commitSha: commit,
            artifactIds: ["declared"],
          },
        ],
      },
    });
  });
});

describe("Workflow wire boundary", () => {
  it("does not accept client stage/revision as workflow authority", () => {
    const input = decodeWorkflowInput({
      task: taskInput,
      repositoryRoot: "/repo",
      workspacesRoot: "/tasks",
      modelSelection: { instanceId: "codex", model: "model:1" },
      issueContext: "Issue",
      plan: ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
        kind,
        name: kind,
        tool: "/usr/bin/true",
        args: [],
        timeoutMs: 1000,
      })),
      stage: "ready",
      revision: 2,
    });
    assert.isFalse("stage" in input);
    assert.isFalse("revision" in input);
  });
  it("requires evidence for ready and bounded revisions for running", () => {
    rejects(decodeWorkflowResult, { state: "ready", revision: 0 });
    rejects(decodeWorkflowResult, {
      state: "running",
      role: "coder",
      revision: 3,
      threadId: "thread:1",
    });
    assert.equal(
      decodeWorkflowResult({ state: "blocked", reason: "corrections_exhausted" }).state,
      "blocked",
    );
  });
});
