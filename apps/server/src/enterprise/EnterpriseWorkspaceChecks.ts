import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sandbox from "./EnterpriseSandboxService.ts";
import { redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";
import * as Secrets from "./EnterpriseSecretService.ts";

import {
  CheckArtifact,
  encodeCheckArtifact,
  encodeGateArtifact,
} from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";
import {
  requireOwnership,
  runGit,
  withOwnership,
  type OwnershipContext,
  type WorkspaceInput,
} from "./EnterpriseWorkspaceOwnership.ts";
/** Check a clean checkout and reject mutations so passing evidence always names the inspected commit. */
export const runChecks = (
  input: WorkspaceInput & {
    readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
    readonly batch: boolean;
  },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.runChecks")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const sandbox = yield* Sandbox.EnterpriseSandboxService;
      const secrets = yield* Secrets.EnterpriseSecretService;
      const { controlDir, worktreePath } = ctx;
      const ownership = yield* requireOwnership(ctx);
      const head = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      yield* secrets.assertCommitClean({ repositoryRoot: worktreePath, commitSha: head });
      const before = (yield* runGit(worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ])).stdout;
      if (before.trim())
        return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
      const checks = input.checks;
      const artifacts: Array<typeof CheckArtifact.Type> = [];
      for (const check of checks) {
        const output = yield* sandbox.run({ spec: input.spec, worktreePath, check });
        const after = (yield* runGit(worktreePath, [
          "status",
          "--porcelain",
          "--untracked-files=all",
        ])).stdout;
        const afterHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
        if (after.trim() || afterHead !== head)
          return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
        artifacts.push({
          name: check.name,
          kind: check.kind,
          status: "passed",
          commitSha: head,
          stdout: redactEnterpriseSecrets(output.stdout),
          stderr: redactEnterpriseSecrets(output.stderr),
        });
      }
      const batch = input.batch;
      const artifactPath = path.join(
        controlDir,
        `${batch ? "gate" : "check"}-${yield* crypto.randomUUIDv4}.json`,
      );
      yield* writeFileStringAtomically({
        filePath: artifactPath,
        contents: batch
          ? yield* encodeGateArtifact({
              task: input.spec,
              commitSha: head,
              checks: artifacts,
            })
          : yield* encodeCheckArtifact(artifacts[0]!),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return ownership;
    }),
  );
