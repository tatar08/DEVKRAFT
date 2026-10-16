import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import type { PriceTable } from "./EnterpriseCost.ts";
import { evaluateTaskBudget, taskCostFromProjections } from "./EnterpriseTaskCost.ts";

const prices: PriceTable = {
  cloud: { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
  local: { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
};

type Turn = Partial<OrchestrationV2ThreadProjection["providerTurns"][number]>;
const projection = (model: string, turns: ReadonlyArray<Turn>) =>
  ({
    thread: { modelSelection: { instanceId: "codex", model } },
    providerTurns: turns,
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "thread" | "providerTurns">;
const complete = (inputTokens: number, outputTokens: number): Turn => ({
  status: "completed",
  startedAt: {} as never,
  turnTokenUsage: {
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens,
    outputTokens,
  },
});

describe("taskCostFromProjections", () => {
  it("sums finished turns across role threads at their own model price", () => {
    const cost = taskCostFromProjections(
      [
        projection("cloud", [complete(100_000, 10_000), complete(100_000, 0)]),
        projection("local", [complete(9_000_000, 9_000_000)]),
      ],
      prices,
    );
    // 30 + 15 and 30 cents for cloud; local is a known zero.
    assert.deepEqual(cost, { providerCents: 75, unpricedRecords: 0 });
  });

  it("blocks cumulative cost overflow across role threads", () => {
    const result = evaluateTaskBudget({
      projections: [
        projection("boundary", [complete(1_000_000, 0)]),
        projection("cloud", [complete(1, 0)]),
      ],
      prices: {
        ...prices,
        boundary: { inputCentsPerMillion: Number.MAX_SAFE_INTEGER, outputCentsPerMillion: 0 },
      },
      limitCents: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(result.cost, {
      providerCents: Number.MAX_SAFE_INTEGER,
      unpricedRecords: 1,
    });
    assert.deepEqual(result.decision, { status: "tripped", reason: "cost_unknown" });
  });

  it("prices each retry at its original model instead of the thread's latest selection", () => {
    const original = projection("local", [
      { ...complete(1_000_000, 0), runAttemptId: "attempt:cloud" as never },
      { ...complete(1_000_000, 0), runAttemptId: "attempt:local" as never },
    ]);
    const cost = taskCostFromProjections(
      [
        {
          ...original,
          runs: [
            { id: "run:cloud", modelSelection: { model: "cloud" } },
            { id: "run:local", modelSelection: { model: "local" } },
          ] as unknown as OrchestrationV2ThreadProjection["runs"],
          attempts: [
            { id: "attempt:cloud", runId: "run:cloud" },
            { id: "attempt:local", runId: "run:local" },
          ] as unknown as OrchestrationV2ThreadProjection["attempts"],
        },
      ],
      prices,
    );
    assert.deepEqual(cost, { providerCents: 300, unpricedRecords: 0 });
    assert.deepEqual(taskCostFromProjections([{ ...original, runs: [], attempts: [] }], prices), {
      providerCents: 0,
      unpricedRecords: 2,
    });
  });

  it("ignores in-flight turns and turns that never started", () => {
    const cost = taskCostFromProjections(
      [
        projection("cloud", [
          { status: "running", startedAt: {} as never },
          { status: "failed", startedAt: null },
        ]),
      ],
      prices,
    );
    assert.deepEqual(cost, { providerCents: 0, unpricedRecords: 0 });
  });

  it("counts started turns without complete usage, and unpriced models, as unknown", () => {
    const cost = taskCostFromProjections(
      [
        projection("cloud", [{ status: "completed", startedAt: {} as never }]),
        projection("mystery", [complete(1, 1)]),
      ],
      prices,
    );
    assert.deepEqual(cost, { providerCents: 0, unpricedRecords: 2 });
  });
});

describe("evaluateTaskBudget", () => {
  it("trips on the task budget and reports the unknown-cost case separately", () => {
    const over = evaluateTaskBudget({
      projections: [projection("cloud", [complete(1_000_000, 100_000)])],
      prices,
      limitCents: 150,
    });
    assert.deepEqual(over.decision, { status: "tripped", reason: "budget_exceeded" });
    const unknown = evaluateTaskBudget({
      projections: [projection("mystery", [complete(1, 1)])],
      prices,
      limitCents: 150,
    });
    assert.deepEqual(unknown.decision, { status: "tripped", reason: "cost_unknown" });
    const within = evaluateTaskBudget({
      projections: [projection("cloud", [complete(100_000, 0)])],
      prices,
      limitCents: 150,
    });
    assert.deepEqual(within.decision, { status: "ok", remainingCents: 120 });
  });
});
