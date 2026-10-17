import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TaskSpec } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Merge from "./EnterpriseMergeService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeSpec = Schema.decodeUnknownSync(TaskSpec);
const testLayer = Layer.mergeAll(Workspace.layer, Merge.layer).pipe(
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * Phase 1 exit criterion: parallel tasks on one repository get isolated worktrees, and their
 * overlapping edits surface as a detected conflict instead of a silent overwrite.
 */
describe("Enterprise parallel task isolation", () => {
  it.effect("isolates concurrently prepared tasks and detects their conflicting edits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
      const workspace = yield* Workspace.EnterpriseWorkspaceService;
      const merge = yield* Merge.EnterpriseMergeService;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-parallel-isolation-" });
      const repositoryRoot = `${temp}/repo`;
      const workspacesRoot = `${temp}/tasks`;
      yield* fs.makeDirectory(repositoryRoot);
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        git.execute({
          operation: "EnterpriseParallelIsolation.test",
          cwd,
          args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
        });
      yield* run(repositoryRoot, ["init", "-b", "main"]);
      yield* fs.writeFileString(`${repositoryRoot}/shared.txt`, "base\n");
      yield* run(repositoryRoot, ["add", "."]);
      yield* run(repositoryRoot, ["commit", "-m", "base"]);
      const base = (yield* run(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
      const spec = (taskId: string) =>
        decodeSpec({
          taskId,
          tenantId: "local",
          projectId: "project:parallel",
          repoCommit: base,
          acceptanceCriteria: ["Pass"],
          approvedTools: [],
          budgetLimit: { currency: "USD", limitCents: 100 },
        });

      // Three tasks start at once; separate task locks must not block or share state.
      const prepare = (taskId: string) =>
        workspace.prepare({ spec: spec(taskId), repositoryRoot, workspacesRoot });
      const [a, b, c] = yield* Effect.all(
        [prepare("task:a"), prepare("task:b"), prepare("task:c")],
        {
          concurrency: "unbounded",
        },
      );
      assert.equal(new Set([a.worktreePath, b.worktreePath, c.worktreePath]).size, 3);
      assert.equal(new Set([a.branch, b.branch, c.branch]).size, 3);

      const commitIn = (worktreePath: string, file: string, contents: string) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${worktreePath}/${file}`, contents);
          yield* run(worktreePath, ["add", file]);
          yield* run(worktreePath, ["commit", "-m", `edit ${file}`]);
          return (yield* run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
        });
      const commitA = yield* commitIn(a.worktreePath, "shared.txt", "from task a\n");
      const commitB = yield* commitIn(b.worktreePath, "shared.txt", "from task b\n");
      const commitC = yield* commitIn(c.worktreePath, "only-c.txt", "from task c\n");

      // Edits never leak across checkouts or into the repository's own checkout.
      assert.equal(yield* fs.readFileString(`${b.worktreePath}/shared.txt`), "from task b\n");
      assert.isFalse(yield* fs.exists(`${a.worktreePath}/only-c.txt`));
      assert.equal(yield* fs.readFileString(`${repositoryRoot}/shared.txt`), "base\n");

      const overlapping = yield* merge
        .check({ repositoryRoot, targetCommit: commitA, taskCommit: commitB })
        .pipe(Effect.flip);
      assert.equal(overlapping._tag, "EnterpriseMergeRejected");
      if (overlapping._tag === "EnterpriseMergeRejected")
        assert.equal(overlapping.reason, "conflict");
      const disjoint = yield* merge.check({
        repositoryRoot,
        targetCommit: commitA,
        taskCommit: commitC,
      });
      assert.match(disjoint.treeSha, /^[a-f0-9]{40}$/);

      // Checks never move refs: main and every task branch are where the tasks left them.
      assert.equal((yield* run(repositoryRoot, ["rev-parse", "main"])).stdout.trim(), base);
      assert.equal((yield* run(repositoryRoot, ["rev-parse", a.branch])).stdout.trim(), commitA);
      assert.equal((yield* run(repositoryRoot, ["rev-parse", b.branch])).stdout.trim(), commitB);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
