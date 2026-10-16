import { ThreadId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Git from "../vcs/GitVcsDriver.ts";

import { encodeOwnership } from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";
import {
  isSecretPath,
  requireOwnership,
  runGit,
  withOwnership,
  type OwnershipContext,
  type WorkspaceInput,
} from "./EnterpriseWorkspaceOwnership.ts";
/**
 * Codex 0.162.1 cannot start its Linux sandbox when the denied .codex/.agents paths are absent
 * (`bwrap: Can't create file ...: Is a directory`). Empty directories remain invisible to Git.
 */
const ensureAgentProtectedDirectories = Effect.fn(
  "EnterpriseWorkspaceService.ensureAgentProtectedDirectories",
)(function* (worktreePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    [".codex", ".agents"],
    (name) => {
      const target = path.join(worktreePath, name);
      return fs
        .exists(target)
        .pipe(Effect.flatMap((exists) => (exists ? Effect.void : fs.makeDirectory(target))));
    },
    { discard: true },
  );
});
/** Reuse only a matching active manifest; an orphan checkout or cleaned task cannot be adopted. */
export const prepare = (input: WorkspaceInput) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.prepare")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git.GitVcsDriver;
      const { repositoryRoot, manifest, worktreePath, branch } = ctx;
      let ownership = ctx.ownership;
      if (ownership !== undefined) {
        if (ownership.status === "cleaned")
          return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
        yield* ensureAgentProtectedDirectories(worktreePath);
        return ownership;
      }
      if (yield* fs.exists(worktreePath))
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      const tracked = (yield* runGit(repositoryRoot, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        input.spec.repoCommit,
      ])).stdout.split("\0");
      if (tracked.some(isSecretPath))
        return yield* new EnterpriseWorkspaceRejected({ reason: "secret_files" });
      yield* git.createWorktree(
        {
          cwd: repositoryRoot,
          refName: input.spec.repoCommit,
          newRefName: branch,
          path: worktreePath,
        },
        { disableHooks: true, submodules: "none" },
      );
      yield* ensureAgentProtectedDirectories(worktreePath);
      ownership = {
        version: 1,
        spec: input.spec,
        repositoryRoot,
        worktreePath,
        branch,
        createdAt: DateTime.toEpochMillis(yield* DateTime.now),
        status: "allocated",
      };
      yield* writeFileStringAtomically({
        filePath: manifest,
        contents: yield* encodeOwnership(ownership),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return ownership;
    }),
  );
/** Remove only unbound, unchanged work so cleanup cannot discard thread work or ignored output. */
export const cleanup = (input: WorkspaceInput) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.cleanup")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git.GitVcsDriver;
      const { repositoryRoot, manifest, worktreePath } = ctx;
      let ownership = ctx.ownership;
      if (ownership === undefined)
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      if (ownership.status === "cleaned") return ownership;
      if ((ownership.boundThreadIds?.length ?? 0) > 0)
        return yield* new EnterpriseWorkspaceRejected({ reason: "busy" });
      /** Ignored files may contain user output: Git removal alone does not protect them. */
      const status = (yield* runGit(worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
      ])).stdout;
      if (status.trim())
        return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
      const head = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      if (head !== input.spec.repoCommit)
        return yield* new EnterpriseWorkspaceRejected({ reason: "new_commits" });
      yield* git.removeWorktree({ cwd: repositoryRoot, path: worktreePath, force: false });
      ownership = { ...ownership, status: "cleaned" };
      yield* writeFileStringAtomically({
        filePath: manifest,
        contents: yield* encodeOwnership(ownership),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return ownership;
    }),
  );
/** Freeze configuration before role threads exist; retired tasks cannot restart or change workflow. */
export const bindWorkflow = (input: WorkspaceInput & { readonly key: string }) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.bindWorkflow")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { manifest } = ctx;
      let ownership = yield* requireOwnership(ctx);
      if (
        ownership.retired ||
        (ownership.workflowKey === undefined && (ownership.boundThreadIds?.length ?? 0) > 0) ||
        !/^[a-f0-9]{64}$/.test(input.key) ||
        (ownership.workflowKey !== undefined && ownership.workflowKey !== input.key)
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      if (ownership.workflowKey === undefined) {
        ownership = { ...ownership, workflowKey: input.key };
        yield* writeFileStringAtomically({
          filePath: manifest,
          contents: yield* encodeOwnership(ownership),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }
      return ownership;
    }),
  );
/** Persist bindings before launch so an uncertain launch still prevents cleanup; retirement is final. */
export const bindThread = (input: WorkspaceInput & { readonly threadId: ThreadId }) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.bindThread")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { manifest } = ctx;
      let ownership = yield* requireOwnership(ctx);
      if (ownership.retired)
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      ownership = {
        ...ownership,
        boundThreadIds: [...new Set([...(ownership.boundThreadIds ?? []), input.threadId])],
      };
      yield* writeFileStringAtomically({
        filePath: manifest,
        contents: yield* encodeOwnership(ownership),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return ownership;
    }),
  );
/** Require the exact bound set before retiring, so a partial release cannot permit unsafe cleanup. */
export const releaseBindings = (
  input: WorkspaceInput & { readonly threadIds: ReadonlyArray<ThreadId> },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.releaseBindings")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { manifest } = ctx;
      let ownership = yield* requireOwnership(ctx);
      const bound = ownership.boundThreadIds ?? [];
      if (
        bound.length !== new Set(input.threadIds).size ||
        bound.some((id) => !input.threadIds.includes(id))
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "busy" });
      ownership = { ...ownership, boundThreadIds: [], retired: true };
      yield* writeFileStringAtomically({
        filePath: manifest,
        contents: yield* encodeOwnership(ownership),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return ownership;
    }),
  );
