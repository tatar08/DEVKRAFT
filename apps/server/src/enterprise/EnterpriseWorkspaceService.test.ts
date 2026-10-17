import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  TaskSpec,
  ThreadId,
  EnterpriseAdvanceWorkflowInput,
  EnterpriseWorkflowAutomationRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import { enterpriseWorkflowKey } from "./EnterpriseWorkflowConfiguration.ts";
import * as Tenancy from "./EnterpriseTenancy.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeAutomationInput = Schema.decodeUnknownEffect(EnterpriseAdvanceWorkflowInput);
const decodeAutomationRecord = Schema.decodeUnknownEffect(EnterpriseWorkflowAutomationRecord);
const decodeSpec = Schema.decodeUnknownEffect(TaskSpec);
const testLayer = Workspace.layer.pipe(
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-enterprise-workspace-" });
  const repositoryRoot = path.join(temp, "repo");
  const workspacesRoot = path.join(temp, "tasks");
  yield* fs.makeDirectory(repositoryRoot);
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({
      operation: "EnterpriseWorkspace.test",
      cwd,
      args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    });
  yield* run(repositoryRoot, ["init"]);
  yield* fs.writeFileString(path.join(repositoryRoot, "README.md"), "fixture\n");
  yield* run(repositoryRoot, ["add", "README.md"]);
  yield* run(repositoryRoot, ["commit", "-m", "fixture"]);
  const commit = (yield* run(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const spec = yield* decodeSpec({
    taskId: "task:one",
    tenantId: "local",
    projectId: "project:test",
    repoCommit: commit,
    acceptanceCriteria: ["Pass"],
    approvedTools: [],
    budgetLimit: { currency: "USD", limitCents: 150 },
  });
  return {
    fs,
    path,
    run,
    spec,
    repositoryRoot,
    workspacesRoot,
    service: yield* Workspace.EnterpriseWorkspaceService,
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("EnterpriseWorkspaceService", () => {
  it.effect("refuses an unlisted tenant before creating any task state", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const foreign = yield* decodeSpec({ ...env.spec, tenantId: "acme" });
        const rejected = yield* env.service.prepare({ ...env, spec: foreign }).pipe(Effect.flip);
        assert.equal(rejected._tag, "EnterpriseWorkspaceRejected");
        if (rejected._tag === "EnterpriseWorkspaceRejected")
          assert.equal(rejected.reason, "tenant_not_allowed");
        assert.isFalse(yield* env.fs.exists(env.workspacesRoot));
      }),
    ),
  );
  it.effect("keeps tenants that share a task ID in separate workspaces", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const acme = yield* decodeSpec({ ...env.spec, tenantId: "acme" });
        const tenancy = Layer.succeed(Tenancy.EnterpriseTenancy, {
          authorize: () => Effect.void,
        });
        const both = yield* Workspace.EnterpriseWorkspaceService.pipe(
          Effect.flatMap((service) =>
            Effect.all([service.prepare(env), service.prepare({ ...env, spec: acme })]),
          ),
          Effect.provide(Layer.fresh(Workspace.layer).pipe(Layer.provide(tenancy))),
        );
        assert.notEqual(both[0].worktreePath, both[1].worktreePath);
        assert.notEqual(both[0].branch, both[1].branch);
        assert.equal(both[1].spec.tenantId, "acme");
      }),
    ),
  );
  it.effect(
    "creates a pinned worktree and reuses persisted ownership across service instances",
    () =>
      provide(
        Effect.gen(function* () {
          const env = yield* setup;
          const first = yield* env.service.prepare(env);
          assert.equal(
            (yield* env.run(first.worktreePath, ["rev-parse", "HEAD"])).stdout.trim(),
            env.spec.repoCommit,
          );
          const second = yield* Workspace.EnterpriseWorkspaceService.pipe(
            Effect.flatMap((recreated) => recreated.prepare(env)),
            Effect.provide(Workspace.layer),
          );
          assert.deepEqual(second, first);
          assert.equal(
            (yield* env.run(env.repositoryRoot, ["worktree", "list", "--porcelain"])).stdout.split(
              "worktree ",
            ).length - 1,
            2,
          );
        }),
      ),
  );
  it.effect("creates the Codex-denied directories without dirtying the worktree", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const owned = yield* env.service.prepare(env);
        for (const name of [".codex", ".agents"])
          assert.isTrue((yield* env.fs.stat(`${owned.worktreePath}/${name}`)).type === "Directory");
        assert.equal((yield* env.run(owned.worktreePath, ["status", "--porcelain"])).stdout, "");
        yield* env.fs.remove(`${owned.worktreePath}/.agents`, { recursive: true });
        yield* env.service.prepare(env);
        assert.isTrue(yield* env.fs.exists(`${owned.worktreePath}/.agents`));
      }),
    ),
  );

  it.effect("blocks a credential embedded in an ordinary source file before checkout", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        yield* env.fs.writeFileString(
          env.path.join(env.repositoryRoot, "config.ts"),
          `const key = "sk-${"x".repeat(40)}";`,
        );
        yield* env.run(env.repositoryRoot, ["add", "."]);
        yield* env.run(env.repositoryRoot, ["commit", "-m", "synthetic credential"]);
        const repoCommit = (yield* env.run(env.repositoryRoot, [
          "rev-parse",
          "HEAD",
        ])).stdout.trim();
        const error = yield* env.service
          .prepare({ ...env, spec: { ...env.spec, repoCommit } })
          .pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "secret_files");
        else assert.fail(error.message);
        assert.equal(
          (yield* env.run(env.repositoryRoot, ["worktree", "list", "--porcelain"])).stdout.split(
            "worktree ",
          ).length - 1,
          1,
        );
      }),
    ),
  );
  it.effect(
    "persists a V2 thread binding and refuses cleanup even if the checkout is pristine",
    () =>
      provide(
        Effect.gen(function* () {
          const env = yield* setup;
          yield* env.service.prepare(env);
          const threadId = ThreadId.make("enterprise:bound:test");
          const bound = yield* env.service.bindThread({ ...env, threadId });
          assert.deepEqual(bound.boundThreadIds, [threadId]);
          const retry = yield* env.service.bindThread({ ...env, threadId });
          assert.deepEqual(retry.boundThreadIds, [threadId]);
          const error = yield* env.service.cleanup(env).pipe(Effect.flip);
          if (error._tag === "EnterpriseWorkspaceRejected") assert.equal(error.reason, "busy");
          else assert.fail(error.message);
          assert.isTrue(yield* env.fs.exists(bound.worktreePath));
        }),
      ),
  );
  it.effect("isolates two tasks and refuses a changed spec for the same identity", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const first = yield* env.service.prepare(env);
        const otherSpec = yield* decodeSpec({ ...env.spec, taskId: "task:two" });
        const second = yield* env.service.prepare({ ...env, spec: otherSpec });
        assert.notEqual(first.worktreePath, second.worktreePath);
        const error = yield* env.service
          .prepare({ ...env, spec: { ...env.spec, acceptanceCriteria: ["Changed"] } })
          .pipe(Effect.flip);
        assert.equal(error._tag, "EnterpriseWorkspaceRejected");
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "ownership_mismatch");
      }),
    ),
  );
  it.effect("cleans a pristine base checkout idempotently while retaining its branch", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const prepared = yield* env.service.prepare(env);
        const cleaned = yield* env.service.cleanup(env);
        assert.equal(cleaned.status, "cleaned");
        assert.isFalse(yield* env.fs.exists(prepared.worktreePath));
        assert.equal(
          (yield* env.run(env.repositoryRoot, ["rev-parse", prepared.branch])).stdout.trim(),
          env.spec.repoCommit,
        );
        assert.deepEqual(yield* env.service.cleanup(env), cleaned);
      }),
    ),
  );
  it.effect("preserves dirty and ignored files during cleanup", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const prepared = yield* env.service.prepare(env);
        yield* env.fs.writeFileString(
          env.path.join(prepared.worktreePath, ".env"),
          "keep-private\n",
        );
        const error = yield* env.service.cleanup(env).pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "dirty_worktree");
        else assert.fail(error.message);
        assert.isTrue(yield* env.fs.exists(prepared.worktreePath));
      }),
    ),
  );
  it.effect("preserves committed task work even with a clean checkout", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const prepared = yield* env.service.prepare(env);
        yield* env.run(prepared.worktreePath, ["commit", "--allow-empty", "-m", "task work"]);
        const error = yield* env.service.cleanup(env).pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected") assert.equal(error.reason, "new_commits");
        else assert.fail(error.message);
      }),
    ),
  );
  it.effect("peeks approval evidence while the gate operation lock is held", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const owned = yield* env.service.prepare(env);
        const lock = env.path.join(env.path.dirname(owned.worktreePath), "operation.lock");
        const file = env.path.join(env.path.dirname(owned.worktreePath), "approvals.json");
        const record = { version: 1 as const, taskId: env.spec.taskId, entries: [] };
        yield* env.fs.writeFileString(file, JSON.stringify(record));
        yield* env.fs.makeDirectory(lock);
        assert.deepEqual(yield* env.service.peekApprovals(env), record);
        const error = yield* env.service.readApprovals(env).pipe(Effect.flip);
        assert.equal(error._tag, "EnterpriseWorkspaceRejected");
        if (error._tag === "EnterpriseWorkspaceRejected") assert.equal(error.reason, "busy");
        assert.isTrue(yield* env.fs.exists(lock));
      }),
    ),
  );

  it.effect("refuses symlinked, oversized and wrong-task approval records when peeking", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const owned = yield* env.service.prepare(env);
        const file = env.path.join(env.path.dirname(owned.worktreePath), "approvals.json");
        const other = env.path.join(env.workspacesRoot, "other.json");
        yield* env.fs.writeFileString(
          other,
          JSON.stringify({ version: 1, taskId: env.spec.taskId, entries: [] }),
        );
        yield* env.fs.symlink(other, file);
        const symlink = yield* env.service.peekApprovals(env).pipe(Effect.flip);
        assert.equal(symlink._tag, "EnterpriseWorkspaceRejected");
        yield* env.fs.remove(file);
        for (const contents of [
          " ".repeat(1_048_577),
          JSON.stringify({ version: 1, taskId: "task:other", entries: [] }),
        ]) {
          yield* env.fs.writeFileString(file, contents);
          const error = yield* env.service.peekApprovals(env).pipe(Effect.flip);
          assert.equal(error._tag, "EnterpriseWorkspaceRejected");
          if (error._tag === "EnterpriseWorkspaceRejected")
            assert.equal(error.reason, "ownership_mismatch");
        }
      }),
    ),
  );

  it.effect("refuses cleanup while an operation lock exists", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const prepared = yield* env.service.prepare(env);
        const lock = env.path.join(env.path.dirname(prepared.worktreePath), "operation.lock");
        yield* env.fs.makeDirectory(lock);
        const error = yield* env.service.cleanup(env).pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected") assert.equal(error.reason, "busy");
        else assert.fail(error.message);
        assert.isTrue(yield* env.fs.exists(lock));
      }),
    ),
  );
  it.effect("disables checkout hooks and refuses host-side checkout filters", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const marker = env.path.join(env.repositoryRoot, "hook-ran");
        const hook = env.path.join(env.repositoryRoot, ".git", "hooks", "post-checkout");
        yield* env.fs.writeFileString(hook, `#!/bin/sh\ntouch '${marker}'\n`);
        yield* env.fs.chmod(hook, 0o755);
        yield* env.service.prepare(env);
        assert.isFalse(yield* env.fs.exists(marker));
        yield* env.run(env.repositoryRoot, ["config", "filter.unsafe.smudge", "sh -c false"]);
        const spec = yield* decodeSpec({ ...env.spec, taskId: "task:filter" });
        const error = yield* env.service.prepare({ ...env, spec }).pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "checkout_filters");
        else assert.fail(error.message);
      }),
    ),
  );
  it.effect("rejects tracked secret file names before checkout", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        yield* env.fs.writeFileString(env.path.join(env.repositoryRoot, ".env"), "fixture-only\n");
        yield* env.run(env.repositoryRoot, ["add", ".env"]);
        yield* env.run(env.repositoryRoot, ["commit", "-m", "secret fixture"]);
        const commit = (yield* env.run(env.repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
        const error = yield* env.service
          .prepare({ ...env, spec: { ...env.spec, repoCommit: commit } })
          .pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "secret_files");
        else assert.fail(error.message);
      }),
    ),
  );
  it.effect("refuses workspace storage inside the source repository", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const error = yield* env.service
          .prepare({ ...env, workspacesRoot: env.path.join(env.repositoryRoot, "tasks") })
          .pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "root_inside_repository");
        else assert.fail(error.message);
      }),
    ),
  );
  it.effect("concurrent prepares never allocate more than one checkout", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const results = yield* Effect.all(
          [Effect.exit(env.service.prepare(env)), Effect.exit(env.service.prepare(env))],
          { concurrency: "unbounded" },
        );
        const successes = results.filter(Exit.isSuccess);
        assert.isAtLeast(successes.length, 1);
        assert.equal(new Set(successes.map((result) => result.value.worktreePath)).size, 1);
        assert.equal(
          (yield* env.run(env.repositoryRoot, ["worktree", "list", "--porcelain"])).stdout.split(
            "worktree ",
          ).length - 1,
          2,
        );
      }),
    ),
  );
  it.effect("does not adopt or remove a checkout whose ownership manifest is missing", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const prepared = yield* env.service.prepare(env);
        yield* env.fs.remove(
          env.path.join(env.path.dirname(prepared.worktreePath), "ownership.json"),
        );
        const error = yield* env.service.prepare(env).pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "allocation_incomplete");
        else assert.fail(error.message);
        assert.isTrue(yield* env.fs.exists(prepared.worktreePath));
      }),
    ),
  );
  it.effect("refuses cleanup if checkout filters were configured after preparation", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const prepared = yield* env.service.prepare(env);
        yield* env.run(env.repositoryRoot, ["config", "filter.unsafe.clean", "sh -c false"]);
        const error = yield* env.service.cleanup(env).pipe(Effect.flip);
        if (error._tag === "EnterpriseWorkspaceRejected")
          assert.equal(error.reason, "checkout_filters");
        else assert.fail(error.message);
        assert.isTrue(yield* env.fs.exists(prepared.worktreePath));
      }),
    ),
  );
});

it.effect("keeps workflow configuration immutable across service instances", () =>
  provide(
    Effect.gen(function* () {
      const env = yield* setup;
      yield* env.service.prepare(env);
      yield* env.service.bindWorkflow({ ...env, key: "a".repeat(64) });
      yield* Workspace.EnterpriseWorkspaceService.pipe(
        Effect.flatMap((service) => service.bindWorkflow({ ...env, key: "a".repeat(64) })),
        Effect.provide(Workspace.layer),
      );
      const mismatch = yield* env.service
        .bindWorkflow({ ...env, key: "b".repeat(64) })
        .pipe(Effect.result);
      assert.equal(mismatch._tag, "Failure");
      const owned = yield* env.service.prepare(env);
      assert.equal(owned.workflowKey, "a".repeat(64));
      const control = env.path.dirname(owned.worktreePath);
      assert.isFalse(yield* env.fs.exists(env.path.join(control, "operation.lock")));
    }),
  ),
);
it.effect("does not adopt manually launched roles as a new managed workflow", () =>
  provide(
    Effect.gen(function* () {
      const env = yield* setup;
      yield* env.service.prepare(env);
      const threadId = ThreadId.make("thread:manual-role");
      yield* env.service.bindThread({ ...env, threadId });
      const rejected = yield* env.service
        .bindWorkflow({ ...env, key: "a".repeat(64) })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      const owned = yield* env.service.prepare(env);
      assert.equal(owned.workflowKey, undefined);
      assert.deepEqual(owned.boundThreadIds, [threadId]);
    }),
  ),
);

it.effect.each(["valid", "symlink", "oversized", "foreign_task", "changed_plan"] as const)(
  "validates persisted workflow registration (%s)",
  (change) =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup;
        const input = yield* decodeAutomationInput({
          task: env.spec,
          repositoryRoot: env.repositoryRoot,
          workspacesRoot: env.workspacesRoot,
          modelSelection: { instanceId: "codex", model: "model:1" },
          issueContext: "Issue",
          plan: ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
            kind,
            name: kind,
            tool: "/usr/bin/true",
            args: [],
            timeoutMs: 1000,
          })),
        });
        const owned = yield* env.service.prepare(env);
        yield* env.service.bindWorkflow({ ...env, key: yield* enterpriseWorkflowKey(input) });
        const record = yield* decodeAutomationRecord({
          version: 1,
          input,
          ownerSessionId: "session:owner",
          enabled: true,
          stopReason: null,
        });
        yield* env.service.writeAutomation({ ...env, record });
        const file = env.path.join(
          env.path.dirname(owned.worktreePath),
          "workflow-automation.json",
        );
        if (change === "symlink") {
          const outside = env.path.join(env.repositoryRoot, "outside-registration.json");
          yield* env.fs.writeFileString(outside, yield* env.fs.readFileString(file));
          yield* env.fs.remove(file);
          yield* env.fs.symlink(outside, file);
        }
        if (change === "oversized") yield* env.fs.writeFileString(file, " ".repeat(1_048_577));
        if (change === "foreign_task" || change === "changed_plan") {
          const contents = JSON.parse(yield* env.fs.readFileString(file));
          if (change === "foreign_task") contents.input.task.taskId = "task:foreign";
          else contents.input.plan[0].timeoutMs = 2000;
          yield* env.fs.writeFileString(file, JSON.stringify(contents));
        }
        const result = yield* Workspace.EnterpriseWorkspaceService.pipe(
          Effect.flatMap((service) => service.readAutomation(env)),
          Effect.provide(Workspace.layer),
          Effect.result,
        );
        assert.equal(result._tag, change === "valid" ? "Success" : "Failure");
        if (result._tag === "Success") assert.deepEqual(result.success, record);
        assert.isFalse(
          yield* env.fs.exists(
            env.path.join(env.path.dirname(owned.worktreePath), "operation.lock"),
          ),
        );
      }),
    ),
);
