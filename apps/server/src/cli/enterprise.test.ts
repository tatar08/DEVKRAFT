import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { enterpriseCommand } from "./enterprise.ts";

const commit = "a".repeat(40);
const bundle = {
  task: {
    taskId: "task:cli",
    tenantId: "local",
    projectId: "project:cli",
    repoCommit: commit,
    acceptanceCriteria: ["Regression passes"],
    approvedTools: [],
    budgetLimit: { currency: "USD", limitCents: 150 },
  },
  evidence: {
    taskId: "task:cli",
    diffSha: commit,
    tests: [
      {
        name: "regression",
        kind: "test",
        status: "passed",
        commitSha: commit,
        artifactIds: ["artifact:test"],
      },
    ],
    securityScan: {
      name: "security",
      kind: "security_scan",
      status: "passed",
      commitSha: commit,
      artifactIds: ["artifact:scan"],
    },
    cost: { currency: "USD", amountCents: 100 },
    provenance: {
      threadId: "thread:cli",
      runId: "run:cli",
      commitSha: commit,
      artifactIds: ["artifact:diff"],
    },
  },
  risk: {
    taskId: "task:cli",
    diffSha: commit,
    tier: 0,
    policyVersion: "policy:1",
    matchedRules: [],
    criticalChanges: [],
    approvers: ["actor:reviewer"],
    expiresAt: Number.MAX_SAFE_INTEGER,
    decision: "approved",
  },
};

const runCli = (contents: string, currentCommit = commit) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-enterprise-evidence-" });
    const file = `${dir}/bundle.json`;
    yield* fs.writeFileString(file, contents);
    return yield* Command.runWith(enterpriseCommand, { version: "0.0.0" })([
      "verify",
      "--bundle",
      file,
      "--commit",
      currentCommit,
      "--policy-version",
      "policy:1",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)));

describe("enterprise verify CLI", () => {
  it.effect("reads and validates a passing evidence bundle without writing runtime state", () =>
    runCli(JSON.stringify(bundle)),
  );
  it.effect("rejects stale evidence when the checkout changes", () =>
    Effect.gen(function* () {
      const error = yield* runCli(JSON.stringify(bundle), "b".repeat(40)).pipe(Effect.flip);
      assert.equal(error._tag, "UserError");
      assert.include(error.message, "stale_diff");
    }),
  );
  it.effect("rejects expired approval", () =>
    Effect.gen(function* () {
      const error = yield* runCli(
        JSON.stringify({ ...bundle, risk: { ...bundle.risk, expiresAt: 0 } }),
      ).pipe(Effect.flip);
      assert.equal(error._tag, "UserError");
      assert.include(error.message, "approval_expired");
    }),
  );
  it.effect("rejects malformed data without exposing its content", () =>
    Effect.gen(function* () {
      const error = yield* runCli('{"secret":"private-test-value"}').pipe(Effect.flip);
      assert.equal(error._tag, "UserError");
      assert.include(error.message, "decode");
      assert.notInclude(error.message, "private-test-value");
    }),
  );
  it.effect("rejects oversized bundles", () =>
    Effect.gen(function* () {
      const error = yield* runCli(" ".repeat(1_048_577)).pipe(Effect.flip);
      assert.equal(error._tag, "UserError");
      assert.include(error.message, "exceeds 1 MiB");
    }),
  );
});

const runCost = (files: { usage: string; pricing: string }, extra: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-enterprise-cost-" });
    yield* fs.writeFileString(`${dir}/usage.json`, files.usage);
    yield* fs.writeFileString(`${dir}/pricing.json`, files.pricing);
    yield* Command.runWith(enterpriseCommand, { version: "0.0.0" })([
      "cost",
      "--usage",
      `${dir}/usage.json`,
      "--pricing",
      `${dir}/pricing.json`,
      "--project",
      "project:cli",
      ...extra,
    ]);
    const logs = yield* TestConsole.logLines;
    return String(logs.at(-1));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)));

const pricing = JSON.stringify({
  version: 1,
  models: {
    cloud: { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
    local: { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
  },
});
const usage = (model: string) =>
  JSON.stringify({
    tasks: [
      { taskId: "task:1", records: [{ model, usage: { inputTokens: 20_000, outputTokens: 0 } }] },
    ],
  });

describe("enterprise cost CLI", () => {
  it.effect("bills a project with markup and reports unpriced usage", () =>
    Effect.gen(function* () {
      const priced = JSON.parse(
        yield* runCost({ usage: usage("cloud"), pricing }, ["--markup-bps", "5000"]),
      );
      assert.deepEqual(priced, {
        projectId: "project:cli",
        providerCents: 6,
        billedCents: 9,
        unpricedRecords: 0,
        taskCount: 1,
        markupBps: 5000,
      });
      const unpriced = JSON.parse(yield* runCost({ usage: usage("mystery"), pricing }));
      assert.equal(unpriced.providerCents, 0);
      assert.equal(unpriced.unpricedRecords, 1);
    }),
  );
  it.effect("rejects bad input without echoing its content", () =>
    Effect.gen(function* () {
      const decode = yield* runCost({ usage: '{"secret":"private-test-value"}', pricing }).pipe(
        Effect.flip,
      );
      assert.include(decode.message, "decode");
      assert.notInclude(decode.message, "private-test-value");
      const markup = yield* runCost({ usage: usage("cloud"), pricing }, [
        "--markup-bps",
        "-1",
      ]).pipe(Effect.flip);
      assert.equal(markup._tag, "UserError");
    }),
  );
});
