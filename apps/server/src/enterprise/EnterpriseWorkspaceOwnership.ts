import type { TaskSpec } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Secrets from "./EnterpriseSecretService.ts";
import { EnterpriseTenancy } from "./EnterpriseTenancy.ts";
import { enterpriseTaskKey } from "./EnterpriseWorkflowConfiguration.ts";
import { Ownership, decodeOwnership, encodeSpec } from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";

/** Identifies a task without choosing an operation or touching disk. */
export type WorkspaceInput = {
  readonly spec: TaskSpec;
  readonly repositoryRoot: string;
  readonly workspacesRoot: string;
};
/** Resolved paths and validated manifest are only used while the operation lock is held. */
export type OwnershipContext = WorkspaceInput & {
  readonly root: string;
  readonly controlDir: string;
  readonly manifest: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly ownership: typeof Ownership.Type | undefined;
};
/** Reject credential-like tracked paths before exposing a checkout to a sandboxed check. */
export const isSecretPath = (name: string) =>
  /(^|\/)\.env(?:\.|$)|(^|\/)(?:id_rsa|id_ed25519|credentials)$|\.(?:pem|key)$/i.test(name);

/** Disable executable repository hooks and filesystem monitors for workspace Git commands. */
export const runGit = Effect.fn("EnterpriseWorkspaceService.git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const git = yield* Git.GitVcsDriver;
  return yield* git.execute({
    operation: "EnterpriseWorkspaceService.git",
    cwd,
    args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
  });
});

/** Refuse symlinked state and mismatched task/checkouts instead of adopting another owner's work. */
const validateManifest = Effect.fn("EnterpriseWorkspaceService.validateManifest")(function* (
  ctx: Omit<OwnershipContext, "ownership">,
) {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git.GitVcsDriver;
  const secrets = yield* Secrets.EnterpriseSecretService;
  const { repositoryRoot, manifest, worktreePath, branch } = ctx;
  /** Checkout filters execute host-side code, outside the check sandbox. */
  const filters = yield* git.execute({
    operation: "EnterpriseWorkspaceService.filters",
    cwd: repositoryRoot,
    args: ["config", "--get-regexp", "^filter\\..*\\.(process|smudge|clean)$"],
    allowNonZeroExit: true,
  });
  if (filters.exitCode === 0)
    return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_filters" });
  yield* secrets.assertCommitClean({ repositoryRoot, commitSha: ctx.spec.repoCommit });
  if (!(yield* fs.exists(manifest))) return undefined;

  if ((yield* fs.realPath(manifest)) !== manifest)
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  const ownership = yield* decodeOwnership(yield* fs.readFileString(manifest));
  if (
    ownership.repositoryRoot !== repositoryRoot ||
    ownership.worktreePath !== worktreePath ||
    ownership.branch !== branch ||
    (yield* encodeSpec(ownership.spec)) !== (yield* encodeSpec(ctx.spec))
  )
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  if (ownership.status === "cleaned") return ownership;
  if ((yield* fs.realPath(worktreePath)) !== worktreePath)
    return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_mismatch" });
  const actualBranch = (yield* runGit(worktreePath, [
    "symbolic-ref",
    "--short",
    "HEAD",
  ])).stdout.trim();
  const commonDir = (yield* runGit(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).stdout.trim();
  const repositoryCommonDir = (yield* runGit(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ])).stdout.trim();
  if (actualBranch !== branch || commonDir !== repositoryCommonDir)
    return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_mismatch" });
  return ownership;
});
/** A cleaned or missing manifest cannot be used to restart work or adopt an orphan checkout. */
export const requireOwnership = Effect.fn("EnterpriseWorkspaceService.requireOwnership")(function* (
  ctx: OwnershipContext,
) {
  if (ctx.ownership === undefined)
    return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
  if (ctx.ownership.status === "cleaned")
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  return ctx.ownership;
});

/** Authorize before any filesystem effect and hold one lock through validation and the operation.
 * Locks have no age-based reclaim: elapsed time cannot prove the previous owner has stopped.
 */
export const withOwnership = Effect.fn("EnterpriseWorkspaceService.withOwnership")(function* <
  A,
  E,
  R,
>(input: WorkspaceInput, use: (ctx: OwnershipContext) => Effect.Effect<A, E, R>) {
  yield* (yield* EnterpriseTenancy)
    .authorize(input.spec.tenantId)
    .pipe(Effect.mapError(() => new EnterpriseWorkspaceRejected({ reason: "tenant_not_allowed" })));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* fs.realPath(input.repositoryRoot);
  yield* fs.makeDirectory(input.workspacesRoot, { recursive: true });
  const root = yield* fs.realPath(input.workspacesRoot);
  const relative = path.relative(repositoryRoot, root);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    return yield* new EnterpriseWorkspaceRejected({ reason: "root_inside_repository" });
  const id = yield* enterpriseTaskKey(input.spec);
  const controlDir = path.join(root, id);
  yield* fs.makeDirectory(controlDir, { recursive: true });
  if ((yield* fs.realPath(controlDir)) !== controlDir)
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  const lock = path.join(controlDir, "operation.lock");

  return yield* Effect.acquireUseRelease(
    fs.makeDirectory(lock).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "AlreadyExists"
            ? Effect.fail(new EnterpriseWorkspaceRejected({ reason: "busy" }))
            : Effect.fail(error),
      }),
    ),
    () =>
      Effect.gen(function* () {
        const ctx = {
          ...input,
          repositoryRoot,
          root,
          controlDir,
          manifest: path.join(controlDir, "ownership.json"),
          worktreePath: path.join(controlDir, "checkout"),
          branch: `enterprise/task-${id}`,
        };
        const ownership = yield* validateManifest(ctx);
        return yield* use({ ...ctx, ownership });
      }),
    () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
  );
});
