import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TaskSpec } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Runner from "../processRunner.ts";
import * as Sandbox from "./EnterpriseSandboxService.ts";

const task = Schema.decodeUnknownSync(TaskSpec)({
  taskId: "task:check",
  tenantId: "local",
  projectId: "project:test",
  repoCommit: "a".repeat(40),
  acceptanceCriteria: ["Tests pass"],
  approvedTools: ["/usr/bin/node"],
  budgetLimit: { currency: "USD", limitCents: 150 },
});
const check = Sandbox.EnterpriseCheck.make({
  name: "regression",
  kind: "test",
  tool: "/usr/bin/node",
  args: ["--version"],
  timeoutMs: 1000,
});
const output: Runner.ProcessRunOutput = {
  code: 0 as Runner.ProcessRunOutput["code"],
  stdout: "fixture",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
const runScenario = (
  run: Runner.ProcessRunner["Service"]["run"],
  spec = task,
  binariesAvailable = true,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-test-" });
    const sandboxFs = FileSystem.FileSystem.of({
      ...fs,
      exists: (name) =>
        name === "/usr/bin/bwrap" || name === "/usr/bin/prlimit"
          ? Effect.succeed(binariesAvailable)
          : fs.exists(name),
    });
    return yield* Effect.gen(function* () {
      const service = yield* Sandbox.EnterpriseSandboxService;
      return yield* service.run({ spec, worktreePath: dir, check });
    }).pipe(
      Effect.provide(
        Sandbox.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Runner.ProcessRunner, { run }),
              Layer.succeed(FileSystem.FileSystem, sandboxFs),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("EnterpriseSandboxService", () => {
  it.effect("refuses missing sandbox binaries before spawning", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* runScenario(
        () => {
          calls++;
          return Effect.succeed(output);
        },
        task,
        false,
      ).pipe(Effect.flip);
      assert.equal(error._tag, "EnterpriseSandboxUnavailable");
      assert.equal(calls, 0);
    }),
  );
  it.effect("denies tools outside the task allowlist before spawning", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* runScenario(
        () => {
          calls++;
          return Effect.succeed(output);
        },
        { ...task, approvedTools: [] },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "EnterpriseCheckRejected");
      assert.equal(calls, 0);
    }),
  );
  it.effect("fails closed when namespace preflight fails and never executes the check", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* runScenario(() => {
        calls++;
        return Effect.succeed({ ...output, code: 1 as Runner.ProcessRunOutput["code"] });
      }).pipe(Effect.flip);
      assert.equal(error._tag, "EnterpriseSandboxUnavailable");
      assert.equal(calls, 1);
    }),
  );
  it.effect(
    "uses a cleared environment, isolated namespaces, bounded resources and a single workspace mount",
    () =>
      Effect.gen(function* () {
        const calls: Runner.ProcessRunInput[] = [];
        yield* runScenario((input) => {
          calls.push(input);
          return Effect.succeed(output);
        });
        assert.lengthOf(calls, 2);
        const args = calls[1]!.args;
        assert.equal(calls[1]!.command, "/usr/bin/bwrap");
        assert.include(args, "--unshare-all");
        assert.include(args, "--clearenv");
        assert.include(args, "--as=2147483648");
        assert.include(args, "--nproc=128");
        assert.lengthOf(
          args.filter((value) => value === "--bind"),
          1,
        );
        assert.deepEqual(args.slice(-2), ["/toolchain/node", "--version"]);
        assert.equal(calls[1]!.maxOutputBytes, 1_048_576);
      }),
  );
  it.effect("does not label a nonzero check exit as passing evidence", () =>
    Effect.gen(function* () {
      let calls = 0;
      const error = yield* runScenario(() =>
        Effect.succeed({
          ...output,
          code: (++calls === 1 ? 0 : 1) as Runner.ProcessRunOutput["code"],
        }),
      ).pipe(Effect.flip);
      assert.equal(error._tag, "EnterpriseCheckRejected");
    }),
  );
});

it.effect("distinguishes timeouts from retryable code-check failures", () =>
  Effect.gen(function* () {
    let calls = 0;
    const error = yield* runScenario(() =>
      Effect.succeed({
        ...output,
        timedOut: ++calls > 1,
        code: (calls > 1 ? 1 : 0) as Runner.ProcessRunOutput["code"],
      }),
    ).pipe(Effect.flip);
    if (error._tag !== "EnterpriseCheckRejected") return assert.fail("Expected check rejection");
    assert.equal(error.reason, "check_timed_out");
  }),
);
