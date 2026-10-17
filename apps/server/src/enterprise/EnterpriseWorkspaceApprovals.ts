import { EnterpriseApprovalEntry, EnterpriseApprovalRecord } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { EnterpriseTenancy } from "./EnterpriseTenancy.ts";
import { enterpriseTaskKey } from "./EnterpriseWorkflowConfiguration.ts";
import { decodeOwnership, encodeSpec } from "./EnterpriseWorkspaceArtifacts.ts";
import { MAX_WORKSPACE_FILE_BYTES } from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";
import {
  requireOwnership,
  withOwnership,
  type OwnershipContext,
  type WorkspaceInput,
} from "./EnterpriseWorkspaceOwnership.ts";

const APPROVALS_FILE = "approvals.json";
/** Oldest decisions are dropped first; only decisions for the current commit can ever count. */
const MAX_ENTRIES = 256;
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(EnterpriseApprovalRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(EnterpriseApprovalRecord));

/** Reads the bounded, non-symlinked record and refuses one written for another task. */
const read = Effect.fn("EnterpriseWorkspaceService.readApprovalFile")(function* (
  input: WorkspaceInput,
  ctx: OwnershipContext,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* requireOwnership(ctx);
  const file = path.join(ctx.controlDir, APPROVALS_FILE);
  if (!(yield* fs.exists(file))) return { file, record: undefined };
  if ((yield* fs.realPath(file)) !== file || (yield* fs.stat(file)).size > MAX_WORKSPACE_FILE_BYTES)
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  const contents = yield* fs.readFileString(file);
  if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  const record = yield* decodeRecord(contents);
  if (record.taskId !== input.spec.taskId)
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  return { file, record };
});

/**
 * Stored decisions for this task. They are audit evidence only: the approval service re-checks
 * every entry against the live session, commit, policy and clock before it counts.
 */
export const readApprovals = (input: WorkspaceInput) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.readApprovals")(function* (ctx: OwnershipContext) {
      return (yield* read(input, ctx)).record;
    }),
  );

/** Polling reads atomic records without contending with gates; stored decisions grant no authority. */
export const peekApprovals = Effect.fn("EnterpriseWorkspaceService.peekApprovals")(function* (
  input: WorkspaceInput,
) {
  yield* (yield* EnterpriseTenancy)
    .authorize(input.spec.tenantId)
    .pipe(Effect.mapError(() => new EnterpriseWorkspaceRejected({ reason: "tenant_not_allowed" })));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = yield* fs.realPath(input.repositoryRoot);
  const root = yield* fs.realPath(input.workspacesRoot);
  const relative = path.relative(repositoryRoot, root);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
    return yield* new EnterpriseWorkspaceRejected({ reason: "root_inside_repository" });
  const id = yield* enterpriseTaskKey(input.spec);
  const controlDir = path.join(root, id);
  const manifest = path.join(controlDir, "ownership.json");
  if (
    (yield* fs.realPath(controlDir)) !== controlDir ||
    (yield* fs.realPath(manifest)) !== manifest ||
    (yield* fs.stat(manifest)).size > MAX_WORKSPACE_FILE_BYTES
  )
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  const ownership = yield* decodeOwnership(yield* fs.readFileString(manifest));
  const worktreePath = path.join(controlDir, "checkout");
  const branch = `enterprise/task-${id}`;
  if (
    ownership.repositoryRoot !== repositoryRoot ||
    ownership.worktreePath !== worktreePath ||
    ownership.branch !== branch ||
    (yield* encodeSpec(ownership.spec)) !== (yield* encodeSpec(input.spec))
  )
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  return (yield* read(input, {
    ...input,
    repositoryRoot,
    root,
    controlDir,
    manifest,
    worktreePath,
    branch,
    ownership,
  })).record;
});

/**
 * Appends one decision under the ownership lock, so concurrent approvers cannot lose each other's
 * entries. A newer decision from the same session for the same commit replaces its earlier one.
 */
export const appendApproval = (
  input: WorkspaceInput & { readonly entry: EnterpriseApprovalEntry },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.appendApproval")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { file, record } = yield* read(input, ctx);
      const kept = (record?.entries ?? []).filter(
        (entry) =>
          entry.sessionId !== input.entry.sessionId || entry.diffSha !== input.entry.diffSha,
      );
      const next = {
        version: 1 as const,
        taskId: input.spec.taskId,
        entries: [...kept, input.entry].slice(-MAX_ENTRIES),
      };
      const contents = yield* encodeRecord(next);
      if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      yield* writeFileStringAtomically({ filePath: file, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      return next;
    }),
  );
