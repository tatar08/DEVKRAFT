// @effect-diagnostics nodeBuiltinImport:off -- Offline benchmark report; no provider or server access.
/** node apps/server/scripts/summarize-enterprise-benchmark.ts /path/to/measurements 3 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
const decodeSample = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      backend: Schema.Literals(["cloud", "local"]),
      fixture: Schema.Literals([
        "inference",
        "workspace_read",
        "docs_write",
        "docs_revision",
        "docs_consistency",
      ]),
      model: Schema.String,
      iteration: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      passed: Schema.Boolean,
      elapsedMs: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
      apiEquivalentCents: Schema.NullOr(
        Schema.Number.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
        ),
      ),
      promptVersion: Schema.optionalKey(Schema.Number),
    }),
  ),
);
const directory = NodePath.resolve(process.argv[2] ?? "");
const repetitions = Number(process.argv[3] ?? 3);
NodeAssert.ok(
  process.argv[2] && Number.isSafeInteger(repetitions) && repetitions > 0 && repetitions <= 10,
);
const fixtures = ["inference", "workspace_read", "docs_write", "docs_revision", "docs_consistency"];
const results = [];
for (const backend of ["cloud", "local"]) {
  const samples: Array<ReturnType<typeof decodeSample>> = [];
  for (const fixture of fixtures)
    for (let iteration = 1; iteration <= repetitions; iteration++) {
      // Every planned sample is required, including failed samples. Never summarize only successes.
      const sample = decodeSample(
        NodeFS.readFileSync(
          NodePath.join(directory, `${backend}-${fixture}-${iteration}.json`),
          "utf8",
        ),
      );
      NodeAssert.equal(sample.backend, backend);
      NodeAssert.equal(sample.fixture, fixture);
      NodeAssert.equal(sample.iteration, iteration);
      samples.push(sample);
    }
  NodeAssert.equal(
    new Set(samples.map((s) => s.promptVersion ?? 1)).size,
    1,
    "Cannot combine prompt versions in one comparison",
  );
  const durations = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  results.push({
    backend,
    models: [...new Set(samples.map((s) => s.model))],
    promptVersions: [...new Set(samples.map((s) => s.promptVersion ?? 1))],
    samples: samples.length,
    passed: samples.filter((s) => s.passed).length,
    failed: samples.filter((s) => !s.passed).length,
    passRate: samples.filter((s) => s.passed).length / samples.length,
    medianElapsedMs: durations[Math.floor(durations.length / 2)],
    totalElapsedMs: durations.reduce((a, b) => a + b, 0),
    apiEquivalentCents: samples.some((s) => s.apiEquivalentCents === null)
      ? null
      : samples.reduce((sum, s) => sum + (s.apiEquivalentCents ?? 0), 0),
    fixtures: fixtures.map((fixture) => ({
      fixture,
      passed: samples.filter((s) => s.fixture === fixture && s.passed).length,
      total: repetitions,
    })),
  });
}
NodeAssert.deepEqual(
  results[0]!.promptVersions,
  results[1]!.promptVersions,
  "Cloud/local prompt versions must match",
);
const report = {
  repetitions,
  results,
  actualSubscriptionChargeCents: null,
  hardwareCostCents: null,
  interpretation:
    "Synthetic scoped tasks; separate native turns; no savings or production-quality claim. All failures included. Local zero provider price excludes hardware/electricity. API-equivalent totals sum per-turn rounded cents.",
};
NodeFS.writeFileSync(NodePath.join(directory, "summary.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
