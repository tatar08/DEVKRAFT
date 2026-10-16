import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_COOLDOWN_MS,
  recordProviderFailure,
  routeWork,
  selectModel,
  type ModelCandidate,
} from "./EnterpriseRouting.ts";

const localA: ModelCandidate = { instanceId: "ollama", model: "llama3", tier: "local" };
const cloudA: ModelCandidate = { instanceId: "codex", model: "gpt-6-luna", tier: "cloud" };
const cloudB: ModelCandidate = {
  instanceId: "claudeAgent",
  model: "claude-sonnet-5-5",
  tier: "cloud",
};
const candidates = [localA, cloudA, cloudB];

describe("routeWork", () => {
  it("sends mechanical work local and design work to the cloud", () => {
    for (const kind of ["test_run", "lint_fix", "typecheck_fix", "docs"] as const)
      assert.deepEqual(routeWork({ kind, criticalChanges: [], localAvailable: true }), {
        tier: "local",
        reason: "kind_prefers_local",
      });
    for (const kind of ["architecture", "implementation", "review"] as const)
      assert.deepEqual(routeWork({ kind, criticalChanges: [], localAvailable: true }), {
        tier: "cloud",
        reason: "kind_requires_cloud",
      });
  });

  it("never routes critical changes local and reports an unavailable local GPU", () => {
    assert.deepEqual(
      routeWork({ kind: "lint_fix", criticalChanges: ["auth"], localAvailable: true }),
      {
        tier: "cloud",
        reason: "critical_change",
      },
    );
    assert.deepEqual(routeWork({ kind: "lint_fix", criticalChanges: [], localAvailable: false }), {
      tier: "cloud",
      reason: "local_unavailable",
    });
  });
});

describe("recordProviderFailure", () => {
  it("cools down only retryable statuses, honouring and capping Retry-After", () => {
    const now = 1_000;
    const limited = recordProviderFailure({
      cooldowns: {},
      failed: cloudA,
      status: 429,
      nowEpochMillis: now,
    });
    assert.deepEqual(limited, { "codex/gpt-6-luna": now + DEFAULT_COOLDOWN_MS });
    const hinted = recordProviderFailure({
      cooldowns: {},
      failed: cloudA,
      status: 429,
      retryAfterMs: 5_000,
      nowEpochMillis: now,
    });
    assert.equal(hinted["codex/gpt-6-luna"], now + 5_000);
    const capped = recordProviderFailure({
      cooldowns: {},
      failed: cloudA,
      status: 503,
      retryAfterMs: 86_400_000,
      nowEpochMillis: now,
    });
    assert.equal(capped["codex/gpt-6-luna"], now + 15 * 60_000);
    assert.deepEqual(
      recordProviderFailure({ cooldowns: {}, failed: cloudA, status: 400, nowEpochMillis: now }),
      {},
    );
  });
});

describe("selectModel", () => {
  const base = { candidates, cooldowns: {}, nowEpochMillis: 1_000, allowCloudFallback: false };

  it("selects the preferred candidate of the tier", () => {
    assert.deepEqual(selectModel({ ...base, tier: "cloud" }), {
      status: "selected",
      candidate: cloudA,
      failedOver: false,
    });
  });

  it("fails over to the next candidate while one is rate limited, then recovers", () => {
    const cooldowns = recordProviderFailure({
      cooldowns: {},
      failed: cloudA,
      status: 429,
      nowEpochMillis: 1_000,
    });
    assert.deepEqual(selectModel({ ...base, cooldowns, tier: "cloud" }), {
      status: "selected",
      candidate: cloudB,
      failedOver: true,
    });
    const recovered = selectModel({
      ...base,
      cooldowns,
      tier: "cloud",
      nowEpochMillis: 1_000 + DEFAULT_COOLDOWN_MS,
    });
    assert.deepEqual(recovered, { status: "selected", candidate: cloudA, failedOver: false });
  });

  it("keeps local work off the cloud unless fallback is explicitly allowed", () => {
    const cooldowns = { [`${localA.instanceId}/${localA.model}`]: 5_000 };
    assert.deepEqual(selectModel({ ...base, cooldowns, tier: "local" }), {
      status: "unavailable",
      retryAtEpochMillis: 5_000,
    });
    assert.deepEqual(selectModel({ ...base, cooldowns, tier: "local", allowCloudFallback: true }), {
      status: "selected",
      candidate: cloudA,
      failedOver: true,
    });
  });

  it("reports the earliest retry time when everything is cooling down", () => {
    const cooldowns = { "codex/gpt-6-luna": 9_000, "claudeAgent/claude-sonnet-5-5": 4_000 };
    assert.deepEqual(selectModel({ ...base, cooldowns, tier: "cloud" }), {
      status: "unavailable",
      retryAtEpochMillis: 4_000,
    });
    assert.deepEqual(selectModel({ ...base, candidates: [], tier: "cloud" }), {
      status: "unavailable",
      retryAtEpochMillis: null,
    });
  });
});
