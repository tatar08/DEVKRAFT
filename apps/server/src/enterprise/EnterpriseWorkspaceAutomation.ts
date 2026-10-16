import { EnterpriseWorkflowAutomationRecord } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { enterpriseSecretKinds } from "./EnterpriseSecretPolicy.ts";
import { enterpriseWorkflowKey } from "./EnterpriseWorkflowConfiguration.ts";
import { MAX_WORKSPACE_FILE_BYTES } from "./EnterpriseWorkspaceArtifacts.ts";

import { decodeAutomation, encodeAutomation, encodeSpec } from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";
import {
  requireOwnership,
  withOwnership,
  type OwnershipContext,
  type WorkspaceInput,
} from "./EnterpriseWorkspaceOwnership.ts";
/** Verify identity, retirement and secret policy before returning or persisting automation. */
const validateAutomation = Effect.fn("EnterpriseWorkspaceService.validateAutomation")(function* (
  input: WorkspaceInput,
  ctx: OwnershipContext,
  record: EnterpriseWorkflowAutomationRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const { repositoryRoot, root } = ctx;
  const ownership = yield* requireOwnership(ctx);
  const contents = yield* encodeAutomation(record);
  if (
    (yield* encodeSpec(record.input.task)) !== (yield* encodeSpec(input.spec)) ||
    (yield* fs.realPath(record.input.repositoryRoot)) !== repositoryRoot ||
    (yield* fs.realPath(record.input.workspacesRoot)) !== root ||
    (yield* enterpriseWorkflowKey(record.input)) !== ownership.workflowKey ||
    (ownership.retired && record.enabled) ||
    new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES ||
    enterpriseSecretKinds(contents).length > 0
  )
    return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
  return contents;
});
/** Read only bounded, non-symlinked records that match this task and frozen workflow. */
export const readAutomation = (input: WorkspaceInput) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.readAutomation")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { controlDir } = ctx;
      yield* requireOwnership(ctx);
      const file = path.join(controlDir, "workflow-automation.json");
      if (!(yield* fs.exists(file))) return undefined;
      if (
        (yield* fs.realPath(file)) !== file ||
        (yield* fs.stat(file)).size > MAX_WORKSPACE_FILE_BYTES
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const contents = yield* fs.readFileString(file);
      if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const record = yield* decodeAutomation(contents);
      yield* validateAutomation(input, ctx, record);
      return record;
    }),
  );
/** Persist only identity-checked, secret-free automation; retired tasks cannot be re-enabled. */
export const writeAutomation = (
  input: WorkspaceInput & { readonly record: EnterpriseWorkflowAutomationRecord },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.writeAutomation")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { controlDir } = ctx;
      yield* requireOwnership(ctx);
      const file = path.join(controlDir, "workflow-automation.json");
      const contents = yield* validateAutomation(input, ctx, input.record);
      if ((yield* fs.exists(file)) && (yield* fs.realPath(file)) !== file)
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      yield* writeFileStringAtomically({ filePath: file, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    }),
  );
