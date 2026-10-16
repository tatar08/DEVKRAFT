import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AgentHandoff, EnterpriseGatePlan, TaskSpec, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Sandbox from "./EnterpriseSandboxService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import type { ProcessRunOutput } from "../processRunner.ts";

const decodeSpec = Schema.decodeUnknownEffect(TaskSpec);
const decodeHandoff = Schema.decodeUnknownEffect(AgentHandoff);
const decodePlan = Schema.decodeUnknownEffect(EnterpriseGatePlan);
const output: ProcessRunOutput = {
  code: 0 as ProcessRunOutput["code"],
  stdout: "passed",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
const scenario = (
  options: {
    recovery?: "valid" | "tampered" | "symlink" | "oversized" | "other_run" | "other_plan";
    failure?:
      | "check"
      | "timeout"
      | "unavailable"
      | "dirty"
      | "ignored"
      | "secret"
      | "secret_file"
      | "orphan"
      | "foreign"
      | "oversized";
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* Git.GitVcsDriver;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-gate-" });
    const repositoryRoot = `${root}/repo`;
    yield* fs.makeDirectory(repositoryRoot);
    const runGit = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: "SnapshotGate.test",
        cwd,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      });
    yield* runGit(repositoryRoot, ["init"]);
    yield* fs.writeFileString(`${repositoryRoot}/file.txt`, "base\n");
    yield* fs.writeFileString(`${repositoryRoot}/.gitignore`, "*.out\n");
    yield* runGit(repositoryRoot, ["add", "."]);
    yield* runGit(repositoryRoot, ["commit", "-m", "base"]);
    const spec = yield* decodeSpec({
      taskId: "task:snapshot",
      tenantId: "local",
      projectId: "project:test",
      repoCommit: (yield* runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim(),
      acceptanceCriteria: ["pass"],
      approvedTools: ["/usr/bin/true"],
      budgetLimit: { currency: "USD", limitCents: 150 },
    });
    yield* fs.writeFileString(
      `${repositoryRoot}/file.txt`,
      options.failure === "secret" ? `sk-${"x".repeat(40)}` : "snapshot\n",
    );
    if (options.failure === "secret_file")
      yield* fs.writeFileString(`${repositoryRoot}/.env.local`, "synthetic fixture");
    yield* runGit(repositoryRoot, ["add", "."]);
    yield* runGit(repositoryRoot, ["commit", "-m", "snapshot"]);
    const commitSha = (yield* runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    let calls = 0;
    const sandbox: Sandbox.EnterpriseSandboxService["Service"] = {
      run: (input) =>
        Effect.gen(function* () {
          calls++;
          assert.equal(
            (yield* runGit(input.worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
            commitSha,
          );
          assert.equal(yield* fs.readFileString(`${input.worktreePath}/file.txt`), "snapshot\n");
          if (options.failure === "timeout")
            return yield* new Sandbox.EnterpriseCheckRejected({ reason: "check_timed_out" });
          if (options.failure === "unavailable")
            return yield* new Sandbox.EnterpriseSandboxUnavailable({});
          if (options.failure === "check")
            return yield* new Sandbox.EnterpriseCheckRejected({ reason: "check_failed" });
          if (options.failure === "dirty" || options.failure === "ignored")
            yield* fs.writeFileString(
              `${input.worktreePath}/${options.failure === "dirty" ? "file.txt" : "scratch.out"}`,
              "preserve evidence\n",
            );
          return {
            ...output,
            stdout: options.failure === "oversized" ? "x".repeat(300_000) : `sk-${"x".repeat(40)}`,
          };
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "EnterpriseCheckRejected" ||
            cause._tag === "EnterpriseSandboxUnavailable"
              ? cause
              : new Sandbox.EnterpriseSandboxError({ cause }),
          ),
        ),
    };
    return yield* Workspace.EnterpriseWorkspaceService.pipe(
      Effect.flatMap((service) =>
        Effect.gen(function* () {
          const input = { spec, repositoryRoot, workspacesRoot: `${root}/tasks` };
          const owned = yield* service.prepare(input);
          const threadId = ThreadId.make("enterprise:test:coder");
          yield* service.bindThread({ ...input, threadId });
          const control = owned.worktreePath.slice(0, -"/checkout".length);
          const snapshotPath = `${control}/snapshot-checkout`;
          // Simulate later agent work. The gate must neither inspect nor overwrite it.
          yield* runGit(owned.worktreePath, ["reset", "--hard", commitSha]);
          yield* fs.writeFileString(`${owned.worktreePath}/file.txt`, "later committed changes\n");
          yield* runGit(owned.worktreePath, ["add", "."]);
          yield* runGit(owned.worktreePath, ["commit", "-m", "later agent HEAD"]);
          const originalHead = (yield* runGit(owned.worktreePath, [
            "rev-parse",
            "HEAD",
          ])).stdout.trim();
          assert.notEqual(originalHead, commitSha);
          yield* fs.writeFileString(`${owned.worktreePath}/file.txt`, "later agent changes\n");
          const originalStatus = (yield* runGit(owned.worktreePath, ["status", "--porcelain"]))
            .stdout;
          if (options.failure === "orphan") {
            yield* fs.makeDirectory(snapshotPath);
            yield* fs.writeFileString(`${snapshotPath}/keep.txt`, "orphan data\n");
          }
          const handoff = yield* decodeHandoff({
            taskId: spec.taskId,
            threadId: options.failure === "foreign" ? "thread:foreign" : threadId,
            runId: "run:completed",
            modelId: { instanceId: "codex", model: "gpt-5.5" },
            commitSha,
            inputArtifactIds: [],
            outputArtifactIds: ["checkpoint:completed"],
            testEvidence: [],
            errors: [],
          });
          const checks = yield* decodePlan(
            ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
              kind,
              name: kind,
              tool: "/usr/bin/true",
              args: [],
              timeoutMs: 1000,
            })),
          );
          const result = yield* service
            .gateSnapshot({ ...input, handoff, checks })
            .pipe(Effect.result);
          assert.equal(
            (yield* runGit(owned.worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
            originalHead,
          );
          assert.equal(
            (yield* runGit(owned.worktreePath, ["status", "--porcelain"])).stdout,
            originalStatus,
          );
          assert.equal(
            yield* fs.readFileString(`${owned.worktreePath}/file.txt`),
            "later agent changes\n",
          );
          const files = yield* fs.readDirectory(control);
          const artifacts = yield* Effect.forEach(
            files.filter((file) => file.startsWith("gate-") && !file.startsWith("gate-failure-")),
            (file) => fs.readFileString(`${control}/${file}`),
          );
          const failures = files.filter((file) => file.startsWith("gate-failure-"));
          let recovered;
          if (options.recovery) {
            assert.lengthOf(failures, 1);
            const file = `${control}/${failures[0]}`;
            if (options.recovery === "tampered") {
              const record = JSON.parse(yield* fs.readFileString(file));
              record.result.failedCheck.name = "foreign-check";
              yield* fs.writeFileString(file, JSON.stringify(record));
            }
            if (options.recovery === "oversized")
              yield* fs.writeFileString(file, " ".repeat(1_048_577));
            if (options.recovery === "symlink") {
              const outside = `${root}/outside-failure.json`;
              yield* fs.writeFileString(outside, yield* fs.readFileString(file));
              yield* fs.remove(file);
              yield* fs.symlink(outside, file);
            }
            recovered = yield* service
              .readSnapshotFailure({
                ...input,
                handoff:
                  options.recovery === "other_run"
                    ? { ...handoff, runId: "run:other" as typeof handoff.runId }
                    : handoff,
                checks:
                  options.recovery === "other_plan"
                    ? checks.map((check) => ({ ...check, name: `other-${check.name}` }))
                    : checks,
              })
              .pipe(Effect.result);
            if (options.recovery === "valid") {
              const again = yield* service.readSnapshotFailure({ ...input, handoff, checks });
              assert.equal(again?.artifactId, failures[0]);
              assert.equal(again?.handoff.commitSha, commitSha);
              assert.deepEqual(again?.handoff.testEvidence, []);
              assert.deepEqual(again?.failedCheck, { name: "test", kind: "test" });
            }
          }
          const retainedSnapshot = yield* fs.exists(snapshotPath);
          if (options.failure === "ignored")
            assert.equal(
              yield* fs.readFileString(`${snapshotPath}/scratch.out`),
              "preserve evidence\n",
            );
          if (options.failure === "dirty")
            assert.equal(
              yield* fs.readFileString(`${snapshotPath}/file.txt`),
              "preserve evidence\n",
            );
          if (options.failure === "orphan")
            assert.equal(yield* fs.readFileString(`${snapshotPath}/keep.txt`), "orphan data\n");
          return {
            result,
            failures,
            recovered,
            calls,
            artifacts,
            retainedSnapshot,
            locked: files.includes("operation.lock"),
            commitSha,
          };
        }),
      ),
      Effect.provide(
        Workspace.layerWithSandbox.pipe(
          Layer.provide(Layer.succeed(Sandbox.EnterpriseSandboxService, sandbox)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Git.layer.pipe(Layer.provideMerge(NodeServices.layer))));

describe("Checkpoint snapshot deterministic gate", () => {
  it.effect(
    "checks the captured commit and records V2 provenance while preserving dirty agent work",
    () =>
      Effect.gen(function* () {
        const env = yield* scenario();
        assert.equal(env.result._tag, "Success");
        assert.equal(env.calls, 4);
        assert.lengthOf(env.artifacts, 1);
        assert.isFalse(env.retainedSnapshot);
        assert.isFalse(env.locked);
        assert.include(env.artifacts[0]!, "checkpoint:completed");
        assert.include(env.artifacts[0]!, "run:completed");
        assert.include(env.artifacts[0]!, env.commitSha);
        assert.include(env.artifacts[0]!, "[REDACTED:");
        assert.isFalse(env.artifacts[0]!.includes(`sk-${"x".repeat(40)}`));
        if (env.result._tag === "Success") {
          assert.lengthOf(env.result.success.handoff.testEvidence, 4);
          assert.isTrue(
            env.result.success.handoff.testEvidence.every(
              (check) =>
                check.commitSha === env.commitSha &&
                check.artifactIds.includes(
                  env.result._tag === "Success" ? env.result.success.artifactId : "",
                ),
            ),
          );
        }
      }),
  );
  it.effect.each([
    "check",
    "timeout",
    "unavailable",
    "dirty",
    "ignored",
    "secret",
    "secret_file",
    "orphan",
    "foreign",
    "oversized",
  ] as const)("fails closed for %s and records no passing artifact", (failure) =>
    Effect.gen(function* () {
      const env = yield* scenario({ failure });
      assert.equal(env.result._tag, "Failure");
      assert.lengthOf(env.artifacts, 0);
      assert.lengthOf(env.failures, failure === "check" ? 1 : 0);
      assert.isFalse(env.locked);
      assert.equal(env.retainedSnapshot, ["dirty", "ignored", "orphan"].includes(failure));
      assert.equal(
        env.calls,
        ["secret", "secret_file", "orphan", "foreign"].includes(failure)
          ? 0
          : failure === "oversized"
            ? 4
            : 1,
      );
    }),
  );
});

it.effect.each(["valid", "tampered", "symlink", "oversized", "other_run", "other_plan"] as const)(
  "reads only scoped persisted failure context (%s)",
  (recovery) =>
    Effect.gen(function* () {
      const env = yield* scenario({ failure: "check", recovery });
      assert.lengthOf(env.artifacts, 0);
      assert.lengthOf(env.failures, 1);
      assert.equal(env.calls, 1);
      assert.isFalse(env.retainedSnapshot);
      if (recovery === "valid" || recovery === "other_run" || recovery === "other_plan") {
        assert.equal(env.recovered?._tag, "Success");
        if (env.recovered?._tag === "Success")
          assert.equal(env.recovered.success === undefined, recovery !== "valid");
      } else assert.equal(env.recovered?._tag, "Failure");
    }),
);
