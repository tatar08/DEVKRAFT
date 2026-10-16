import { AgentHandoff, EnterpriseGatePlan } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sandbox from "./EnterpriseSandboxService.ts";
import { redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";
import { MAX_WORKSPACE_FILE_BYTES } from "./EnterpriseWorkspaceArtifacts.ts";

import {
  decodeArtifactId,
  decodeFailureArtifact,
  decodeHandoff,
  decodePlan,
  decodeSnapshotArtifact,
  encodeFailureKey,
  encodeFailurePlan,
  encodeHandoff,
  encodeSpec,
} from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";
import {
  requireOwnership,
  withOwnership,
  type OwnershipContext,
  type WorkspaceInput,
} from "./EnterpriseWorkspaceOwnership.ts";
/** Stable failure identity makes retries reuse the same evidence. */
export const failureId = Effect.fn("EnterpriseWorkspaceService.failureId")(function* (
  handoff: AgentHandoff,
  plan: typeof EnterpriseGatePlan.Type,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(yield* encodeFailureKey({ handoff, plan })),
  );
  return `gate-failure-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}.json`;
});
/** Redact command arguments before persisting check plans. */
export const safePlan = (plan: typeof EnterpriseGatePlan.Type) =>
  plan.map((check) => ({ ...check, args: check.args.map(redactEnterpriseSecrets) }));
/** Match task, thread, handoff and redacted plan before reusing bounded failure evidence. */
export const readSnapshotFailure = (
  input: WorkspaceInput & {
    readonly handoff: AgentHandoff;
    readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
  },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.readSnapshotFailure")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { controlDir } = ctx;
      const ownership = yield* requireOwnership(ctx);
      const handoff = yield* decodeHandoff(input.handoff);
      const checks = yield* decodePlan(input.checks);
      if (
        !ownership.boundThreadIds?.includes(handoff.threadId) ||
        handoff.taskId !== input.spec.taskId
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const artifactId = yield* failureId(handoff, checks);
      const artifactPath = path.join(controlDir, artifactId);
      if (!(yield* fs.exists(artifactPath))) return undefined;
      if (
        (yield* fs.realPath(artifactPath)) !== artifactPath ||
        (yield* fs.stat(artifactPath)).size > MAX_WORKSPACE_FILE_BYTES
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const contents = yield* fs.readFileString(artifactPath);
      if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const artifact = yield* decodeFailureArtifact(contents);
      if (
        artifact.result.artifactId !== artifactId ||
        (yield* encodeSpec(artifact.task)) !== (yield* encodeSpec(input.spec)) ||
        (yield* encodeHandoff(artifact.result.handoff)) !== (yield* encodeHandoff(handoff)) ||
        (yield* encodeFailurePlan(artifact.plan)) !==
          (yield* encodeFailurePlan(safePlan(checks))) ||
        !checks.some(
          (check) =>
            check.name === artifact.result.failedCheck.name &&
            check.kind === artifact.result.failedCheck.kind,
        ) ||
        checks.some((check) => !input.spec.approvedTools.includes(check.tool))
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      return artifact.result;
    }),
  );
/** Match the original handoff and every check to its plan and commit before trusting gate evidence. */
export const readSnapshotGate = (
  input: WorkspaceInput & { readonly handoff: AgentHandoff; readonly artifactId: string },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.readSnapshotGate")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { controlDir } = ctx;
      const ownership = yield* requireOwnership(ctx);
      const artifactId = yield* decodeArtifactId(input.artifactId);
      const handoff = yield* decodeHandoff(input.handoff);
      if (
        !ownership.boundThreadIds?.includes(handoff.threadId) ||
        handoff.taskId !== input.spec.taskId
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const artifactPath = path.join(controlDir, artifactId);
      if (
        (yield* fs.realPath(artifactPath)) !== artifactPath ||
        (yield* fs.stat(artifactPath)).size > MAX_WORKSPACE_FILE_BYTES
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const contents = yield* fs.readFileString(artifactPath);
      if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const artifact = yield* decodeSnapshotArtifact(contents);
      const recorded = artifact.result.handoff;
      const originalHandoff = {
        ...recorded,
        testEvidence: [],
        outputArtifactIds: recorded.outputArtifactIds.filter((id) => id !== artifactId),
      };
      if (
        artifact.result.artifactId !== artifactId ||
        (yield* encodeSpec(artifact.task)) !== (yield* encodeSpec(input.spec)) ||
        (yield* encodeHandoff(originalHandoff)) !== (yield* encodeHandoff(handoff)) ||
        artifact.checks.length !== recorded.testEvidence.length ||
        artifact.plan.length !== artifact.checks.length ||
        artifact.checks.some((check, index) => {
          const evidence = recorded.testEvidence[index]!;
          const command = artifact.plan[index]!;
          return (
            check.commitSha !== handoff.commitSha ||
            check.name !== evidence.name ||
            check.kind !== evidence.kind ||
            command.name !== check.name ||
            command.kind !== check.kind ||
            !input.spec.approvedTools.includes(command.tool)
          );
        })
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      return artifact.result;
    }),
  );
