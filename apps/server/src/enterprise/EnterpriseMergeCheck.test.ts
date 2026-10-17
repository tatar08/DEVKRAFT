import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentHandoff,
  EnterpriseCheckMergeInput,
  EnterpriseRoleError,
  TaskSpec,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as MergeCheck from "./EnterpriseMergeCheck.ts";
import * as Roles from "./EnterpriseRoleService.ts";

const decodeSpec = Schema.decodeUnknownSync(TaskSpec);
const decodeHandoff = Schema.decodeUnknownSync(AgentHandoff);
const decodeInput = Schema.decodeUnknownSync(EnterpriseCheckMergeInput);

/** A repository whose `main` and task commits are built per scenario. */
const scenario = (options: {
  readonly taskEdits: string;
  readonly mainEdits?: string;
  readonly handoff?: "missing";
  readonly targetBranch?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* Git.GitVcsDriver;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-merge-check-" });
    const run = (args: ReadonlyArray<string>) =>
      git.execute({
        operation: "EnterpriseMergeCheck.test",
        cwd: root,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      });
    const commit = (file: string, contents: string, message: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${root}/${file}`, contents);
        yield* run(["add", "."]);
        yield* run(["commit", "-m", message]);
        return (yield* run(["rev-parse", "HEAD"])).stdout.trim();
      });
    yield* run(["init", "-b", "main"]);
    const base = yield* commit("file.txt", "base\n", "base");
    yield* run(["checkout", "-b", "task"]);
    const taskCommit = yield* commit("file.txt", options.taskEdits, "task");
    yield* run(["checkout", "main"]);
    if (options.mainEdits !== undefined) yield* commit("file.txt", options.mainEdits, "main");
    const before = (yield* run(["rev-parse", "main"])).stdout.trim();
    let requested: unknown;
    const roles = Layer.mock(Roles.EnterpriseRoleService)({
      collectHandoff: (request) =>
        Effect.suspend(() => {
          requested = request;
          return options.handoff === "missing"
            ? Effect.fail(new EnterpriseRoleError({ reason: "predecessor_incomplete" }))
            : Effect.succeed(
                decodeHandoff({
                  taskId: "task:merge",
                  threadId: "thread:coder",
                  runId: "run:coder",
                  modelId: { instanceId: "codex", model: "model" },
                  commitSha: taskCommit,
                  inputArtifactIds: [],
                  outputArtifactIds: ["checkpoint:1"],
                  testEvidence: [],
                  errors: [],
                }),
              );
        }),
    });
    const result = yield* MergeCheck.EnterpriseMergeCheck.pipe(
      Effect.flatMap((service) =>
        service.check(
          decodeInput({
            task: decodeSpec({
              taskId: "task:merge",
              tenantId: "local",
              projectId: "project:merge",
              repoCommit: base,
              acceptanceCriteria: ["Pass"],
              approvedTools: [],
              budgetLimit: { currency: "USD", limitCents: 100 },
            }),
            repositoryRoot: root,
            workspacesRoot: `${root}-tasks`,
            revision: 1,
            targetBranch: options.targetBranch ?? "main",
          }),
        ),
      ),
      Effect.provide(MergeCheck.layer.pipe(Layer.provide(roles))),
      Effect.result,
    );
    return {
      result,
      requested,
      taskCommit,
      before,
      after: (yield* run(["rev-parse", "main"])).stdout.trim(),
      status: (yield* run(["status", "--porcelain"])).stdout,
    };
  }).pipe(Effect.scoped, Effect.provide(Git.layer.pipe(Layer.provideMerge(NodeServices.layer))));

const reason = (result: { readonly _tag: string; readonly failure?: unknown }) => {
  assert.equal(result._tag, "Failure");
  return (result.failure as { readonly reason: string }).reason;
};

describe("EnterpriseMergeCheck", () => {
  it.effect("checks the server-resolved Coder commit against a branch without moving it", () =>
    Effect.gen(function* () {
      const env = yield* scenario({ taskEdits: "base\ntask\n" });
      assert.equal(env.result._tag, "Success");
      if (env.result._tag === "Success") {
        assert.equal(env.result.success.taskCommit, env.taskCommit);
        assert.equal(env.result.success.targetCommit, env.before);
      }
      // The handoff, not the client, chooses the commit for the requested revision.
      assert.include(env.requested as object, { role: "coder", revision: 1 });
      assert.equal(env.after, env.before);
      assert.equal(env.status, "");
    }),
  );

  it.effect("reports a conflict without leaving merge state", () =>
    Effect.gen(function* () {
      const env = yield* scenario({ taskEdits: "task\n", mainEdits: "main\n" });
      assert.equal(reason(env.result), "conflict");
      assert.equal(env.after, env.before);
      assert.equal(env.status, "");
    }),
  );

  it.effect("refuses when the Coder handoff is not complete", () =>
    Effect.gen(function* () {
      const env = yield* scenario({ taskEdits: "base\ntask\n", handoff: "missing" });
      assert.equal(reason(env.result), "handoff_unavailable");
    }),
  );

  it.effect("refuses a target branch that does not exist", () =>
    Effect.gen(function* () {
      const env = yield* scenario({ taskEdits: "base\ntask\n", targetBranch: "absent" });
      assert.equal(reason(env.result), "target_not_found");
    }),
  );

  it("rejects branch names that could act as options or leave refs/heads", () => {
    for (const targetBranch of ["--output=/tmp/x", "-c", "../HEAD", ""])
      assert.throws(() =>
        decodeInput({
          task: decodeSpec({
            taskId: "task:merge",
            tenantId: "local",
            projectId: "project:merge",
            repoCommit: "a".repeat(40),
            acceptanceCriteria: ["Pass"],
            approvedTools: [],
            budgetLimit: { currency: "USD", limitCents: 100 },
          }),
          repositoryRoot: "/repo",
          workspacesRoot: "/tasks",
          targetBranch,
        }),
      );
  });
});
