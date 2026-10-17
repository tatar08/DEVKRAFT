import {
  EnterpriseCheckMergeInput,
  EnterpriseMergeCheckError,
  EnterpriseMergeCheckResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Merge from "./EnterpriseMergeService.ts";
import * as Roles from "./EnterpriseRoleService.ts";

const decodeInput = Schema.decodeUnknownEffect(EnterpriseCheckMergeInput);
const decodeResult = Schema.decodeUnknownEffect(EnterpriseMergeCheckResult);
const reject = (reason: EnterpriseMergeCheckError["reason"], cause?: unknown) =>
  new EnterpriseMergeCheckError({ reason, ...(cause === undefined ? {} : { cause }) });

/**
 * Authenticated, read-only merge feasibility for one task revision (Phase 1). Executing a merge
 * stays service-only until Phase 4 approval persistence exists, so this RPC can never move a ref.
 */
export class EnterpriseMergeCheck extends Context.Service<
  EnterpriseMergeCheck,
  {
    readonly check: (
      input: EnterpriseCheckMergeInput,
    ) => Effect.Effect<EnterpriseMergeCheckResult, EnterpriseMergeCheckError>;
  }
>()("t3/enterprise/EnterpriseMergeCheck") {}

const make = Effect.gen(function* () {
  const roles = yield* Roles.EnterpriseRoleService;
  const merge = yield* Merge.EnterpriseMergeService;
  const git = yield* Git.GitVcsDriver;
  const check = Effect.fn("EnterpriseMergeCheck.check")(function* (raw: EnterpriseCheckMergeInput) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError((cause) => reject("invalid_input", cause)),
    );
    // The task commit comes from the completed, secret-scanned Coder checkpoint, never the client.
    const handoff = yield* roles
      .collectHandoff({ ...input, role: "coder", revision: input.revision ?? 0 })
      .pipe(Effect.mapError((cause) => reject("handoff_unavailable", cause)));
    // `--end-of-options` and the refs/heads/ prefix keep a branch name from acting as an option.
    const target = yield* git
      .execute({
        operation: "EnterpriseMergeCheck.target",
        cwd: input.repositoryRoot,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `refs/heads/${input.targetBranch}^{commit}`,
        ],
        allowNonZeroExit: true,
        maxOutputBytes: 4096,
      })
      .pipe(Effect.mapError((cause) => reject("check_failed", cause)));
    const targetCommit = target.stdout.trim();
    if (target.exitCode !== 0 || targetCommit === "") return yield* reject("target_not_found");
    const result = yield* merge
      .check({
        repositoryRoot: input.repositoryRoot,
        targetCommit,
        taskCommit: handoff.commitSha,
      })
      .pipe(
        Effect.catchTags({
          EnterpriseMergeRejected: (rejected) =>
            Effect.fail(
              rejected.reason === "conflict" ||
                rejected.reason === "busy" ||
                rejected.reason === "merge_driver"
                ? reject(rejected.reason)
                : reject("check_failed", rejected),
            ),
          EnterpriseMergeError: (cause) => Effect.fail(reject("check_failed", cause)),
        }),
      );
    return yield* decodeResult({ targetBranch: input.targetBranch, ...result }).pipe(
      Effect.mapError((cause) => reject("check_failed", cause)),
    );
  });
  return EnterpriseMergeCheck.of({ check });
});

export const layer = Layer.effect(EnterpriseMergeCheck, make).pipe(
  Layer.provide(Merge.layer),
  Layer.provide(Git.layer),
);
