import {
  EnterpriseApprovalBlocker,
  PullRequestEvidence,
  RiskDecision,
  TaskSpec,
  getEnterpriseApprovalBlockers,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";

const Commit = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const Input = Schema.Struct({
  repositoryRoot: Schema.String,
  targetCommit: Commit,
  taskCommit: Commit,
});
const TargetRef = Schema.String.check(Schema.isPattern(/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/));
const ExecuteInput = Schema.Struct({
  repositoryRoot: Schema.String,
  /** Fully qualified branch; the caller states the target commit it approved against. */
  targetRef: TargetRef,
  expectedTargetCommit: Commit,
  task: TaskSpec,
  evidence: PullRequestEvidence,
  risk: RiskDecision,
  currentPolicyVersion: Schema.String,
});
const decodeInput = Schema.decodeUnknownEffect(Input);
const decodeExecuteInput = Schema.decodeUnknownEffect(ExecuteInput);
const decodeCommit = Schema.decodeUnknownEffect(Commit);
export class EnterpriseMergeRejected extends Schema.TaggedError<EnterpriseMergeRejected>()(
  "EnterpriseMergeRejected",
  {
    reason: Schema.Literals([
      "busy",
      "conflict",
      "invalid_commit",
      "merge_driver",
      "invalid_ref",
      "target_moved",
      "target_checked_out",
      "blocked",
    ]),
    blockers: Schema.optionalKey(Schema.Array(EnterpriseApprovalBlocker)),
  },
) {
  override get message(): string {
    return `Enterprise merge rejected: ${this.reason}${
      this.blockers ? ` (${this.blockers.join(", ")})` : ""
    }.`;
  }
}
export class EnterpriseMergeError extends Schema.TaggedError<EnterpriseMergeError>()(
  "EnterpriseMergeError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Enterprise merge failed.";
  }
}
type MergeFailure = EnterpriseMergeRejected | EnterpriseMergeError;
export class EnterpriseMergeService extends Context.Service<
  EnterpriseMergeService,
  {
    readonly check: (
      input: typeof Input.Type,
    ) => Effect.Effect<
      { readonly targetCommit: string; readonly taskCommit: string; readonly treeSha: string },
      MergeFailure
    >;
    /** Evidence-gated merge: advances one local branch by compare-and-swap. Never pushes. */
    readonly execute: (input: typeof ExecuteInput.Type) => Effect.Effect<
      {
        readonly targetRef: string;
        readonly previousCommit: string;
        readonly mergeCommit: string;
      },
      MergeFailure
    >;
  }
>()("t3/enterprise/EnterpriseMergeService") {}
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  type Run = (args: ReadonlyArray<string>) => ReturnType<typeof git.execute>;

  /** Runs `use` under the repository-wide lock shared by every worktree. */
  const locked = <A, E>(repositoryRootInput: string, use: (run: Run) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      const repositoryRoot = yield* fs.realPath(repositoryRootInput);
      const run: Run = (args) =>
        git.execute({
          operation: "EnterpriseMergeService.git",
          cwd: repositoryRoot,
          args: ["-c", "core.hooksPath=/dev/null", ...args],
          allowNonZeroExit: true,
          maxOutputBytes: 1_048_576,
        });
      const common = yield* run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (common.exitCode !== 0)
        return yield* new EnterpriseMergeRejected({ reason: "invalid_commit" });
      const commonDir = yield* fs.realPath(common.stdout.trim());
      // Never reclaim a stale lock by age.
      const lock = path.join(commonDir, "enterprise-merge.lock");
      return yield* Effect.acquireUseRelease(
        fs.makeDirectory(lock).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "AlreadyExists"
                ? Effect.fail(new EnterpriseMergeRejected({ reason: "busy" }))
                : Effect.fail(error),
          }),
        ),
        () => use(run),
        () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
      );
    });

  /** Verifies both commits and computes the merged tree without touching any ref, index or checkout. */
  const preflight = Effect.fn("EnterpriseMergeService.preflight")(function* (
    run: Run,
    targetCommit: string,
    taskCommit: string,
  ) {
    const drivers = yield* run(["config", "--get-regexp", "^merge\\..*\\.driver$"]);
    if (drivers.exitCode === 0)
      return yield* new EnterpriseMergeRejected({ reason: "merge_driver" });
    if (drivers.exitCode !== 1) return yield* new EnterpriseMergeError({ cause: drivers.exitCode });
    for (const sha of [targetCommit, taskCommit]) {
      const verified = yield* run(["rev-parse", "--verify", `${sha}^{commit}`]);
      if (verified.exitCode !== 0 || verified.stdout.trim() !== sha)
        return yield* new EnterpriseMergeRejected({ reason: "invalid_commit" });
    }
    // Writes unreachable tree objects only.
    const merged = yield* run([
      "merge-tree",
      "--write-tree",
      "--no-messages",
      targetCommit,
      taskCommit,
    ]);
    if (merged.exitCode === 1) return yield* new EnterpriseMergeRejected({ reason: "conflict" });
    if (merged.exitCode !== 0) return yield* new EnterpriseMergeError({ cause: merged.exitCode });
    return yield* decodeCommit(merged.stdout.trim()).pipe(
      Effect.mapError((cause) => new EnterpriseMergeError({ cause })),
    );
  });

  const check = Effect.fn("EnterpriseMergeService.check")(function* (raw: typeof Input.Type) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(() => new EnterpriseMergeRejected({ reason: "invalid_commit" })),
    );
    return yield* locked(input.repositoryRoot, (run) =>
      Effect.gen(function* () {
        const treeSha = yield* preflight(run, input.targetCommit, input.taskCommit);
        return { targetCommit: input.targetCommit, taskCommit: input.taskCommit, treeSha };
      }),
    );
  });

  const execute = Effect.fn("EnterpriseMergeService.execute")(function* (
    raw: typeof ExecuteInput.Type,
  ) {
    const input = yield* decodeExecuteInput(raw).pipe(
      Effect.mapError(() => new EnterpriseMergeRejected({ reason: "invalid_commit" })),
    );
    // Approval is evaluated against the exact commit that will be merged.
    const taskCommit = input.evidence.diffSha;
    const now = yield* DateTime.now;
    const blockers = getEnterpriseApprovalBlockers({
      task: input.task,
      evidence: input.evidence,
      risk: input.risk,
      currentCommitSha: taskCommit,
      currentPolicyVersion: input.currentPolicyVersion,
      nowEpochMillis: DateTime.toEpochMillis(now),
    });
    if (blockers.length > 0)
      return yield* new EnterpriseMergeRejected({ reason: "blocked", blockers });
    return yield* locked(input.repositoryRoot, (run) =>
      Effect.gen(function* () {
        const format = yield* run(["check-ref-format", input.targetRef]);
        if (format.exitCode !== 0)
          return yield* new EnterpriseMergeRejected({ reason: "invalid_ref" });
        const current = yield* run([
          "rev-parse",
          "--verify",
          "--quiet",
          `${input.targetRef}^{commit}`,
        ]);
        if (current.exitCode !== 0 || current.stdout.trim() !== input.expectedTargetCommit)
          return yield* new EnterpriseMergeRejected({ reason: "target_moved" });
        // update-ref on a checked-out branch would desynchronize that worktree's index.
        const worktrees = yield* run(["worktree", "list", "--porcelain"]);
        if (worktrees.exitCode !== 0)
          return yield* new EnterpriseMergeError({ cause: worktrees.exitCode });
        if (worktrees.stdout.split("\n").includes(`branch ${input.targetRef}`))
          return yield* new EnterpriseMergeRejected({ reason: "target_checked_out" });
        const treeSha = yield* preflight(run, input.expectedTargetCommit, taskCommit);
        const message = `Merge task ${input.task.taskId} (${taskCommit})`;
        const created = yield* run([
          "-c",
          "user.name=T3 Code Enterprise",
          "-c",
          "user.email=enterprise@t3.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          treeSha,
          "-p",
          input.expectedTargetCommit,
          "-p",
          taskCommit,
          "-m",
          message,
        ]);
        if (created.exitCode !== 0)
          return yield* new EnterpriseMergeError({ cause: created.exitCode });
        const mergeCommit = yield* decodeCommit(created.stdout.trim()).pipe(
          Effect.mapError((cause) => new EnterpriseMergeError({ cause })),
        );
        // Compare-and-swap: fails if the branch moved since it was verified above.
        const updated = yield* run([
          "update-ref",
          "-m",
          message,
          input.targetRef,
          mergeCommit,
          input.expectedTargetCommit,
        ]);
        if (updated.exitCode !== 0)
          return yield* new EnterpriseMergeRejected({ reason: "target_moved" });
        return {
          targetRef: input.targetRef,
          previousCommit: input.expectedTargetCommit,
          mergeCommit,
        };
      }),
    );
  });

  const normalize = Effect.mapError((cause: { readonly _tag: string }): MergeFailure =>
    cause._tag === "EnterpriseMergeRejected" || cause._tag === "EnterpriseMergeError"
      ? (cause as MergeFailure)
      : new EnterpriseMergeError({ cause }),
  );
  return EnterpriseMergeService.of({
    check: (input) => check(input).pipe(normalize),
    execute: (input) => execute(input).pipe(normalize),
  });
});
export const layer = Layer.effect(EnterpriseMergeService, make).pipe(Layer.provide(Git.layer));
