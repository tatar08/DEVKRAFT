import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { TaskSpec } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import * as Sandbox from "./EnterpriseSandboxService.ts";
import type { ProcessRunOutput } from "../processRunner.ts";
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
const decodeSpec = Schema.decodeUnknownEffect(TaskSpec);
const scenario = (
  run: Sandbox.EnterpriseSandboxService["Service"]["run"],
  kinds: ReadonlyArray<string> = ["test", "lint", "typecheck", "security_scan"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* Git.GitVcsDriver;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gate-test-" });
    const repositoryRoot = `${dir}/repo`;
    yield* fs.makeDirectory(repositoryRoot);
    const gitRun = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "EnterpriseGate.test",
        cwd: repositoryRoot,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      });
    yield* gitRun(["init"]);
    yield* fs.writeFileString(`${repositoryRoot}/file.txt`, "fixture\n");
    yield* gitRun(["add", "."]);
    yield* gitRun(["commit", "-m", "base"]);
    const spec = yield* decodeSpec({
      taskId: "task:gate",
      tenantId: "local",
      projectId: "project:test",
      repoCommit: (yield* gitRun(["rev-parse", "HEAD"])).stdout.trim(),
      acceptanceCriteria: ["pass"],
      approvedTools: ["/usr/bin/true"],
      budgetLimit: { currency: "USD", limitCents: 150 },
    });
    const specPath = `${dir}/spec.json`;
    const planPath = `${dir}/plan.json`;
    yield* fs.writeFileString(specPath, JSON.stringify(spec));
    yield* fs.writeFileString(
      planPath,
      JSON.stringify(
        kinds.map((kind) => ({
          kind,
          name: kind,
          tool: "/usr/bin/true",
          args: [],
          timeoutMs: 1000,
        })),
      ),
    );
    const service = yield* Workspace.EnterpriseWorkspaceService;
    const workspacesRoot = `${dir}/tasks`;
    const ownership = yield* service.prepare({ spec, repositoryRoot, workspacesRoot });
    const result = yield* service
      .gateFile({ specPath, planPath, repositoryRoot, workspacesRoot })
      .pipe(Effect.result);
    const control = ownership.worktreePath.slice(0, -"/checkout".length);
    const files = yield* fs.readDirectory(control);
    const artifacts = yield* Effect.forEach(
      files.filter((file) => file.startsWith("gate-")),
      (file) => fs.readFileString(`${control}/${file}`),
    );
    return { result, artifacts, locked: files.includes("operation.lock"), sha: spec.repoCommit };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Workspace.layerWithSandbox.pipe(
        Layer.provide(Layer.succeed(Sandbox.EnterpriseSandboxService, { run })),
        Layer.provideMerge(Git.layer),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
describe("Enterprise deterministic gate", () => {
  it.effect(
    "executes all required checks at one commit and redacts recorded credential output",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const secret = "sk-" + "x".repeat(40);
        const result = yield* scenario((input) => {
          calls.push(input.check.kind);
          return Effect.succeed({ ...output, stdout: secret });
        });
        assert.equal(result.result._tag, "Success");
        assert.deepEqual(calls, ["test", "lint", "typecheck", "security_scan"]);
        assert.lengthOf(result.artifacts, 1);
        assert.isFalse(result.artifacts[0]!.includes(secret));
        assert.include(result.artifacts[0]!, result.sha);
        assert.include(result.artifacts[0]!, "[REDACTED:");
        assert.isFalse(result.locked);
      }),
  );
  it.effect("stops at the first failed check and records no passing gate", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* scenario(() =>
        ++calls === 2
          ? Effect.fail(new Sandbox.EnterpriseCheckRejected({ reason: "check_failed" }))
          : Effect.succeed(output),
      );
      assert.equal(calls, 2);
      assert.equal(result.result._tag, "Failure");
      assert.lengthOf(result.artifacts, 0);
      assert.isFalse(result.locked);
    }),
  );
  it.effect("rejects missing check kinds before execution", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* scenario(() => {
        calls++;
        return Effect.succeed(output);
      }, ["test", "lint", "security_scan"]);
      assert.equal(calls, 0);
      assert.equal(result.result._tag, "Failure");
      assert.lengthOf(result.artifacts, 0);
    }),
  );
  it.effect("rejects a check that changes the verified checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const result = yield* scenario((input) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${input.worktreePath}/file.txt`, "changed");
          return output;
        }).pipe(Effect.mapError((cause) => new Sandbox.EnterpriseSandboxError({ cause }))),
      );
      assert.equal(result.result._tag, "Failure");
      assert.lengthOf(result.artifacts, 0);
      assert.isFalse(result.locked);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
