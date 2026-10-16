import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TASK_BUDGET_CENTS,
  applyMarkup,
  billProject,
  emptyTaskCost,
  evaluateBudget,
  priceUsage,
  recordUsage,
  type PriceTable,
} from "./EnterpriseCost.ts";

const prices: PriceTable = {
  cloud: { inputCentsPerMillion: 300, outputCentsPerMillion: 1500, cachedInputCentsPerMillion: 30 },
  local: { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
};

describe("priceUsage", () => {
  it("prices input, cached input and output, rounding up", () => {
    // (900k * 300 + 100k * 30 + 10k * 1500) / 1e6 = 288 cents
    assert.equal(
      priceUsage(
        { inputTokens: 1_000_000, cachedInputTokens: 100_000, outputTokens: 10_000 },
        prices.cloud,
      ),
      288,
    );
    assert.equal(priceUsage({ inputTokens: 1, outputTokens: 1 }, prices.cloud), 1);
  });

  it("treats a local model as a known zero and an unpriced model as unknown", () => {
    assert.equal(priceUsage({ inputTokens: 5_000_000, outputTokens: 5_000_000 }, prices.local), 0);
    assert.isNull(priceUsage({ inputTokens: 1, outputTokens: 1 }, undefined));
  });

  it("rejects malformed usage and prices instead of guessing", () => {
    assert.isNull(priceUsage({ inputTokens: -1, outputTokens: 0 }, prices.cloud));
    assert.isNull(priceUsage({ inputTokens: 1.5, outputTokens: 0 }, prices.cloud));
    assert.isNull(
      priceUsage({ inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 }, prices.cloud),
    );
    assert.isNull(
      priceUsage(
        { inputTokens: 1, outputTokens: 1 },
        { inputCentsPerMillion: -1, outputCentsPerMillion: 0 },
      ),
    );
  });
});

describe("applyMarkup and billProject", () => {
  it("applies basis-point markup rounded up and rejects invalid input", () => {
    assert.equal(applyMarkup(100, 2500), 125);
    assert.equal(applyMarkup(3, 2500), 4);
    assert.equal(applyMarkup(100, 0), 100);
    assert.isNull(applyMarkup(100, -1));
    assert.isNull(applyMarkup(-1, 0));
  });

  it("bills a project from its tasks and surfaces unpriced usage", () => {
    const a = recordUsage(
      emptyTaskCost,
      { model: "cloud", usage: { inputTokens: 20_000, outputTokens: 0 } },
      prices,
    );
    const b = recordUsage(
      emptyTaskCost,
      { model: "mystery", usage: { inputTokens: 1, outputTokens: 1 } },
      prices,
    );
    const billing = billProject({ projectId: "project:1", markupBps: 5000, tasks: [a, b] });
    assert.deepEqual(billing, {
      projectId: "project:1",
      providerCents: 6,
      billedCents: 9,
      unpricedRecords: 1,
    });
  });
});

describe("evaluateBudget", () => {
  it("defaults to a $1.50 task ceiling", () => {
    assert.equal(DEFAULT_TASK_BUDGET_CENTS, 150);
  });

  it("stays ok at the limit and trips once spend exceeds it", () => {
    assert.deepEqual(
      evaluateBudget({ state: { providerCents: 150, unpricedRecords: 0 }, limitCents: 150 }),
      { status: "ok", remainingCents: 0 },
    );
    assert.deepEqual(
      evaluateBudget({ state: { providerCents: 151, unpricedRecords: 0 }, limitCents: 150 }),
      { status: "tripped", reason: "budget_exceeded" },
    );
  });

  it("refuses a call whose estimate would cross the limit", () => {
    assert.deepEqual(
      evaluateBudget({
        state: { providerCents: 100, unpricedRecords: 0 },
        limitCents: 150,
        nextCallEstimateCents: 51,
      }),
      { status: "tripped", reason: "budget_exceeded" },
    );
  });

  it("fails closed on unpriced usage and invalid limits", () => {
    assert.deepEqual(
      evaluateBudget({ state: { providerCents: 0, unpricedRecords: 1 }, limitCents: 150 }),
      { status: "tripped", reason: "cost_unknown" },
    );
    assert.equal(evaluateBudget({ state: emptyTaskCost, limitCents: 0 }).status, "tripped");
  });

  it("stops a retry loop of cloud calls at the ceiling", () => {
    let state = emptyTaskCost;
    let calls = 0;
    while (evaluateBudget({ state, limitCents: 150 }).status === "ok" && calls < 1000) {
      state = recordUsage(
        state,
        { model: "cloud", usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
        prices,
      );
      calls += 1;
    }
    assert.isBelow(calls, 1000);
    assert.isAbove(state.providerCents, 150);
  });
});

describe("cost arithmetic boundaries", () => {
  const invalidCounts = [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1];

  it.each(invalidCounts)("blocks malformed spend, unknown counts and estimates: %s", (value) => {
    for (const state of [
      { providerCents: value, unpricedRecords: 0 },
      { providerCents: 0, unpricedRecords: value },
    ]) {
      assert.deepEqual(evaluateBudget({ state, limitCents: 150 }), {
        status: "tripped",
        reason: "cost_unknown",
      });
    }
    assert.deepEqual(
      evaluateBudget({
        state: emptyTaskCost,
        limitCents: 150,
        nextCallEstimateCents: value,
      }),
      { status: "tripped", reason: "cost_unknown" },
    );
  });

  it("rejects usage whose priced total exceeds safe integer cents", () => {
    for (const rate of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER]) {
      assert.isNull(
        priceUsage(
          { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
          { inputCentsPerMillion: rate, outputCentsPerMillion: 0 },
        ),
      );
    }
  });

  it("calculates markup exactly at the safe integer boundary", () => {
    assert.equal(applyMarkup(Number.MAX_SAFE_INTEGER, 0), Number.MAX_SAFE_INTEGER);
    assert.isNull(applyMarkup(Number.MAX_SAFE_INTEGER, 1));
    assert.equal(applyMarkup(0, Number.MAX_SAFE_INTEGER), 0);
  });

  it("marks cumulative usage overflow as unknown without losing the known total", () => {
    const cost = recordUsage(
      { providerCents: Number.MAX_SAFE_INTEGER, unpricedRecords: 0 },
      { model: "cloud", usage: { inputTokens: 1, outputTokens: 0 } },
      prices,
    );
    assert.deepEqual(cost, { providerCents: Number.MAX_SAFE_INTEGER, unpricedRecords: 1 });
    assert.deepEqual(evaluateBudget({ state: cost, limitCents: Number.MAX_SAFE_INTEGER }), {
      status: "tripped",
      reason: "cost_unknown",
    });
  });

  it.each(invalidCounts)("rejects invalid individual billing records: %s", (value) => {
    for (const tasks of [
      [
        { providerCents: value, unpricedRecords: 0 },
        { providerCents: 100, unpricedRecords: 0 },
      ],
      [{ providerCents: 0, unpricedRecords: value }],
    ]) {
      assert.isNull(billProject({ projectId: "project:1", markupBps: 0, tasks }));
    }
  });

  it("blocks projected overspend without overflowing and allows the exact remainder", () => {
    const state = { providerCents: Number.MAX_SAFE_INTEGER - 1, unpricedRecords: 0 };
    assert.deepEqual(
      evaluateBudget({
        state,
        limitCents: Number.MAX_SAFE_INTEGER,
        nextCallEstimateCents: 2,
      }),
      { status: "tripped", reason: "budget_exceeded" },
    );
    assert.deepEqual(
      evaluateBudget({
        state,
        limitCents: Number.MAX_SAFE_INTEGER,
        nextCallEstimateCents: 1,
      }),
      { status: "ok", remainingCents: 1 },
    );
  });

  it("rejects overflow in project cost and unpriced record totals", () => {
    for (const field of ["providerCents", "unpricedRecords"] as const) {
      assert.isNull(
        billProject({
          projectId: "project:1",
          markupBps: 0,
          tasks: [
            { ...emptyTaskCost, [field]: Number.MAX_SAFE_INTEGER },
            { ...emptyTaskCost, [field]: 1 },
          ],
        }),
      );
    }
  });
});
