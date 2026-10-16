import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { PullRequestEvidence, RiskDecision, TaskSpec } from "@t3tools/contracts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Merge from "./EnterpriseMergeService.ts";
const decodeTaskSpec = Schema.decodeUnknownSync(TaskSpec);
const decodeEvidence = Schema.decodeUnknownSync(PullRequestEvidence);
const decodeRisk = Schema.decodeUnknownSync(RiskDecision);
const testLayer = Merge.layer.pipe(
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-merge-test-" });
  const run = (args: ReadonlyArray<string>) =>
    git.execute({
      operation: "EnterpriseMerge.test",
      cwd: root,
      args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    });
  yield* run(["init"]);
  yield* fs.writeFileString(`${root}/file.txt`, "base\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "base"]);
  const base = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
  return { fs, root, run, base, service: yield* Merge.EnterpriseMergeService };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(testLayer));
describe("EnterpriseMergeService", () => {
  it.effect("checks a merge without moving the target ref or touching the checkout", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        yield* env.run(["checkout", "-b", "task"]);
        yield* env.fs.writeFileString(`${env.root}/new.txt`, "task\n");
        yield* env.run(["add", "."]);
        yield* env.run(["commit", "-m", "task"]);
        const task = (yield* env.run(["rev-parse", "HEAD"])).stdout.trim();
        yield* env.run(["checkout", "--detach", env.base]);
        const result = yield* env.service.check({
          repositoryRoot: env.root,
          targetCommit: env.base,
          taskCommit: task,
        });
        assert.match(result.treeSha, /^[a-f0-9]{40}$/);
        assert.equal((yield* env.run(["rev-parse", "HEAD"])).stdout.trim(), env.base);
        assert.isFalse(yield* env.fs.exists(`${env.root}/new.txt`));
        assert.equal((yield* env.run(["status", "--porcelain"])).stdout, "");
      }),
    ),
  );
  it.effect("rejects conflicting commits without leaving merge state", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        yield* env.fs.writeFileString(`${env.root}/file.txt`, "target\n");
        yield* env.run(["add", "."]);
        yield* env.run(["commit", "-m", "target"]);
        const target = (yield* env.run(["rev-parse", "HEAD"])).stdout.trim();
        yield* env.run(["checkout", "--detach", env.base]);
        yield* env.fs.writeFileString(`${env.root}/file.txt`, "task\n");
        yield* env.run(["add", "."]);
        yield* env.run(["commit", "-m", "task"]);
        const task = (yield* env.run(["rev-parse", "HEAD"])).stdout.trim();
        const error = yield* env.service
          .check({ repositoryRoot: env.root, targetCommit: target, taskCommit: task })
          .pipe(Effect.flip);
        assert.equal(error._tag, "EnterpriseMergeRejected");
        if (error._tag === "EnterpriseMergeRejected") assert.equal(error.reason, "conflict");
        assert.isFalse(yield* env.fs.exists(`${env.root}/.git/MERGE_HEAD`));
        assert.equal((yield* env.run(["status", "--porcelain"])).stdout, "");
      }),
    ),
  );
  it.effect("refuses busy repository locks and preserves the owner's lock", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        yield* env.fs.makeDirectory(`${env.root}/.git/enterprise-merge.lock`);
        const error = yield* env.service
          .check({ repositoryRoot: env.root, targetCommit: env.base, taskCommit: env.base })
          .pipe(Effect.flip);
        if (error._tag === "EnterpriseMergeRejected") assert.equal(error.reason, "busy");
        else assert.fail(error.message);
        assert.isTrue(yield* env.fs.exists(`${env.root}/.git/enterprise-merge.lock`));
      }),
    ),
  );
  it.effect("refuses configured executable merge drivers", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        yield* env.run(["config", "merge.custom.driver", "touch SHOULD_NOT_EXIST"]);
        const error = yield* env.service
          .check({ repositoryRoot: env.root, targetCommit: env.base, taskCommit: env.base })
          .pipe(Effect.flip);
        if (error._tag === "EnterpriseMergeRejected") assert.equal(error.reason, "merge_driver");
        else assert.fail(error.message);
        assert.isFalse(yield* env.fs.exists(`${env.root}/SHOULD_NOT_EXIST`));
      }),
    ),
  );

  describe("execute", () => {
    const approvalFor = (commit: string, overrides: { readonly decision?: "pending" } = {}) => {
      const check = {
        name: "regression",
        kind: "test",
        status: "passed",
        commitSha: commit,
        artifactIds: ["artifact:tests"],
      } as const;
      return {
        task: decodeTaskSpec({
          taskId: "task:1",
          tenantId: "local",
          projectId: "project:1",
          repoCommit: commit,
          acceptanceCriteria: ["Regression test passes"],
          approvedTools: ["git.read"],
          budgetLimit: { currency: "USD", limitCents: 150 },
        }),
        evidence: decodeEvidence({
          taskId: "task:1",
          diffSha: commit,
          tests: [check],
          securityScan: { ...check, name: "security", kind: "security_scan" },
          cost: { currency: "USD", amountCents: 100 },
          provenance: {
            threadId: "thread:1",
            runId: "run:1",
            commitSha: commit,
            artifactIds: ["artifact:diff"],
          },
        }),
        risk: decodeRisk({
          taskId: "task:1",
          diffSha: commit,
          tier: 0,
          policyVersion: "policy:1",
          matchedRules: [],
          criticalChanges: [],
          approvers: ["actor:reviewer"],
          expiresAt: 4_102_444_800_000,
          decision: overrides.decision ?? "approved",
        }),
        currentPolicyVersion: "policy:1",
      };
    };
    /** Task commit on a side branch; `refs/heads/target` points at base and is not checked out. */
    const withTask = Effect.gen(function* () {
      const env = yield* setup;
      yield* env.run(["checkout", "-b", "task"]);
      yield* env.fs.writeFileString(`${env.root}/new.txt`, "task\n");
      yield* env.run(["add", "."]);
      yield* env.run(["commit", "-m", "task"]);
      const task = (yield* env.run(["rev-parse", "HEAD"])).stdout.trim();
      yield* env.run(["branch", "target", env.base]);
      yield* env.run(["checkout", "--detach", env.base]);
      return { ...env, task };
    });
    const executeInput = (env: {
      readonly root: string;
      readonly base: string;
      readonly task: string;
    }) => ({
      repositoryRoot: env.root,
      targetRef: "refs/heads/target",
      expectedTargetCommit: env.base,
      ...approvalFor(env.task),
    });

    it.effect("advances the target by compare-and-swap with a two-parent merge commit", () =>
      provide(
        Effect.gen(function* () {
          const env = yield* withTask;
          const result = yield* env.service.execute(executeInput(env));
          assert.equal(result.previousCommit, env.base);
          const head = (yield* env.run(["rev-parse", "refs/heads/target"])).stdout.trim();
          assert.equal(head, result.mergeCommit);
          const parents = (yield* env.run(["rev-list", "--parents", "-n", "1", head])).stdout
            .trim()
            .split(" ");
          assert.deepEqual(parents.slice(1), [env.base, env.task]);
          assert.equal((yield* env.run(["show", `${head}:new.txt`])).stdout, "task\n");
          assert.equal((yield* env.run(["rev-parse", "HEAD"])).stdout.trim(), env.base);
          assert.isFalse(yield* env.fs.exists(`${env.root}/.git/enterprise-merge.lock`));
        }),
      ),
    );

    it.effect("rejects without moving any ref when approval is not granted", () =>
      provide(
        Effect.gen(function* () {
          const env = yield* withTask;
          const error = yield* env.service
            .execute({ ...executeInput(env), ...approvalFor(env.task, { decision: "pending" }) })
            .pipe(Effect.flip);
          if (error._tag !== "EnterpriseMergeRejected") return assert.fail(error.message);
          assert.equal(error.reason, "blocked");
          assert.deepEqual(error.blockers, ["approval_required"]);
          assert.equal(
            (yield* env.run(["rev-parse", "refs/heads/target"])).stdout.trim(),
            env.base,
          );
        }),
      ),
    );

    it.effect("rejects when the target moved since approval", () =>
      provide(
        Effect.gen(function* () {
          const env = yield* withTask;
          yield* env.run(["checkout", "--detach", "target"]);
          yield* env.run(["commit", "--allow-empty", "-m", "moved"]);
          const moved = (yield* env.run(["rev-parse", "HEAD"])).stdout.trim();
          yield* env.run(["branch", "-f", "target", moved]);
          yield* env.run(["checkout", "--detach", env.base]);
          const error = yield* env.service.execute(executeInput(env)).pipe(Effect.flip);
          if (error._tag !== "EnterpriseMergeRejected") return assert.fail(error.message);
          assert.equal(error.reason, "target_moved");
          assert.equal((yield* env.run(["rev-parse", "refs/heads/target"])).stdout.trim(), moved);
        }),
      ),
    );

    it.effect("refuses to move a branch that is checked out in a worktree", () =>
      provide(
        Effect.gen(function* () {
          const env = yield* withTask;
          yield* env.run(["checkout", "target"]);
          const error = yield* env.service.execute(executeInput(env)).pipe(Effect.flip);
          if (error._tag !== "EnterpriseMergeRejected") return assert.fail(error.message);
          assert.equal(error.reason, "target_checked_out");
          assert.equal(
            (yield* env.run(["rev-parse", "refs/heads/target"])).stdout.trim(),
            env.base,
          );
        }),
      ),
    );

    it.effect("rejects conflicts and malformed refs without changing the target", () =>
      provide(
        Effect.gen(function* () {
          const env = yield* withTask;
          const bad = yield* env.service
            .execute({ ...executeInput(env), targetRef: "refs/heads/a..b" })
            .pipe(Effect.flip);
          if (bad._tag !== "EnterpriseMergeRejected") return assert.fail(bad.message);
          assert.equal(bad.reason, "invalid_ref");
          const missing = yield* env.service
            .execute({ ...executeInput(env), targetRef: "refs/heads/missing" })
            .pipe(Effect.flip);
          if (missing._tag !== "EnterpriseMergeRejected") return assert.fail(missing.message);
          assert.equal(missing.reason, "target_moved");
          assert.equal(
            (yield* env.run(["rev-parse", "refs/heads/target"])).stdout.trim(),
            env.base,
          );
        }),
      ),
    );
  });
});
