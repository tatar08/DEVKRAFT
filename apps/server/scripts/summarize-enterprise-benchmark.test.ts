// @effect-diagnostics nodeBuiltinImport:off -- Runs the offline summarizer script as a CLI.
import * as NodeChildProcess from "node:child_process";
import { assert, describe, it } from "@effect/vitest";

const evidence = new URL("../../../docs/benchmarks/enterprise-phase3-2026-10-17/", import.meta.url)
  .pathname;

interface BackendSummary {
  readonly backend: "cloud" | "local";
  readonly models: ReadonlyArray<string>;
  readonly samples: number;
  readonly passed: number;
  readonly medianElapsedMs: number;
  readonly apiEquivalentCents: number | null;
}

const summarize = (promptVersion: 1 | 2) => {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [
      new URL("./summarize-enterprise-benchmark.ts", import.meta.url).pathname,
      `${evidence}prompt-v${promptVersion}`,
      "3",
    ],
    { encoding: "utf8" },
  );
  const results = (JSON.parse(output) as { readonly results: ReadonlyArray<BackendSummary> })
    .results;
  const byBackend = (backend: BackendSummary["backend"]) =>
    results.find((result) => result.backend === backend)!;
  return { cloud: byBackend("cloud"), local: byBackend("local") };
};

/**
 * The Blueprint's Phase 3 claims are pinned to the committed raw samples: editing either the
 * evidence or the published numbers without the other fails here.
 */
describe("Enterprise Phase 3 benchmark evidence", () => {
  it("reproduces the published prompt-v2 comparison from the committed samples", () => {
    const { cloud, local } = summarize(2);
    assert.deepEqual(cloud.models, ["gpt-6.1-sol"]);
    assert.deepEqual(local.models, ["ollama/qwen3-coder:30b"]);
    assert.equal(`${cloud.passed}/${cloud.samples}`, "15/15");
    assert.equal(`${local.passed}/${local.samples}`, "13/15");
    assert.equal((cloud.medianElapsedMs / 1000).toFixed(2), "8.53");
    assert.equal((local.medianElapsedMs / 1000).toFixed(2), "6.78");
    assert.equal(cloud.apiEquivalentCents, 53);
    assert.equal(local.apiEquivalentCents, 0);
  });

  it("retains the earlier prompt-v1 failures instead of dropping them", () => {
    const { cloud, local } = summarize(1);
    assert.equal(`${cloud.passed}/${cloud.samples}`, "15/15");
    assert.equal(`${local.passed}/${local.samples}`, "11/15");
  });
});
