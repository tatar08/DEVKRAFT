import {
  AgentHandoff,
  EnterpriseGatePlan,
  EnterpriseSnapshotGateFailure,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Sandbox from "./EnterpriseSandboxService.ts";
import { redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";
import * as Secrets from "./EnterpriseSecretService.ts";
import { MAX_WORKSPACE_FILE_BYTES } from "./EnterpriseWorkspaceArtifacts.ts";

import {
  CheckArtifact,
  decodeHandoff,
  decodePlan,
  decodeSnapshotResult,
  encodeFailureArtifact,
  encodeSnapshotArtifact,
} from "./EnterpriseWorkspaceArtifacts.ts";
import { EnterpriseWorkspaceRejected } from "./EnterpriseWorkspaceErrors.ts";
import { failureId, safePlan } from "./EnterpriseWorkspaceEvidence.ts";
import {
  isSecretPath,
  requireOwnership,
  runGit,
  withOwnership,
  type OwnershipContext,
  type WorkspaceInput,
} from "./EnterpriseWorkspaceOwnership.ts";
/** Preserve dirty or ignored check output for review; Git alone may remove ignored files. */
const cleanupSnapshot = Effect.fn("EnterpriseWorkspaceService.cleanupSnapshot")(function* (
  repositoryRoot: string,
  snapshotPath: string,
  commitSha: string,
) {
  const git = yield* Git.GitVcsDriver;

  const status = (yield* runGit(snapshotPath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignored",
  ])).stdout;
  const head = (yield* runGit(snapshotPath, ["rev-parse", "HEAD"])).stdout.trim();
  if (!status.trim() && head === commitSha)
    yield* git.removeWorktree({
      cwd: repositoryRoot,
      path: snapshotPath,
      force: false,
    });
});
/** Run checks on the detached commit and always attempt conservative cleanup. */
const runSnapshotChecks = Effect.fn("EnterpriseWorkspaceService.runSnapshotChecks")(function* (
  input: WorkspaceInput,
  repositoryRoot: string,
  snapshotPath: string,
  commitSha: string,
  checks: typeof EnterpriseGatePlan.Type,
) {
  const sandbox = yield* Sandbox.EnterpriseSandboxService;
  let failedCheck: EnterpriseSnapshotGateFailure["failedCheck"] | undefined;
  const artifacts = yield* Effect.acquireUseRelease(
    runGit(repositoryRoot, ["worktree", "add", "--detach", snapshotPath, commitSha]),
    () =>
      Effect.gen(function* () {
        const artifacts: Array<typeof CheckArtifact.Type> = [];
        for (const check of checks) {
          const attempt = yield* sandbox
            .run({
              spec: input.spec,
              worktreePath: snapshotPath,
              check,
            })
            .pipe(Effect.result);
          if (
            attempt._tag === "Failure" &&
            !(
              attempt.failure._tag === "EnterpriseCheckRejected" &&
              attempt.failure.reason === "check_failed"
            )
          )
            return yield* Effect.fail(attempt.failure);
          const status = (yield* runGit(snapshotPath, [
            "status",
            "--porcelain",
            "--untracked-files=all",
            "--ignored",
          ])).stdout;
          const head = (yield* runGit(snapshotPath, ["rev-parse", "HEAD"])).stdout.trim();
          if (status.trim() || head !== commitSha)
            return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
          if (attempt._tag === "Failure") {
            failedCheck = { name: check.name, kind: check.kind };
            break;
          }
          const output = attempt.success;
          artifacts.push({
            name: check.name,
            kind: check.kind,
            status: "passed",
            commitSha,
            stdout: redactEnterpriseSecrets(output.stdout),
            stderr: redactEnterpriseSecrets(output.stderr),
          });
        }
        return artifacts;
      }),
    () => cleanupSnapshot(repositoryRoot, snapshotPath, commitSha).pipe(Effect.ignore),
  );
  return { artifacts, failedCheck };
});
/** Persist only bounded, redacted evidence; failed retries reuse the stable failure artifact. */
const persistSnapshot = Effect.fn("EnterpriseWorkspaceService.persistSnapshot")(function* (
  input: WorkspaceInput,
  controlDir: string,
  handoff: AgentHandoff,
  checks: typeof EnterpriseGatePlan.Type,
  commitSha: string,
  evidence: Effect.Success<ReturnType<typeof runSnapshotChecks>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { artifacts, failedCheck } = evidence;
  if (failedCheck !== undefined) {
    const artifactId = yield* failureId(handoff, checks);
    const contents = yield* encodeFailureArtifact({
      version: 1,
      task: input.spec,
      result: { artifactId, handoff, failedCheck, reason: "check_failed" },
      plan: safePlan(checks),
    });
    if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
      return yield* new EnterpriseWorkspaceRejected({ reason: "check_failed" });
    if (!(yield* fs.exists(path.join(controlDir, artifactId))))
      yield* writeFileStringAtomically({
        filePath: path.join(controlDir, artifactId),
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    return yield* new EnterpriseWorkspaceRejected({
      reason: "check_failed",
      artifactId,
    });
  }
  const artifactId = `gate-${yield* crypto.randomUUIDv4}.json`;
  const result = yield* decodeSnapshotResult({
    artifactId,
    handoff: {
      ...handoff,
      outputArtifactIds: [...handoff.outputArtifactIds, artifactId],
      testEvidence: artifacts.map((check) => ({
        name: check.name,
        kind: check.kind,
        status: check.status,
        commitSha,
        artifactIds: [artifactId],
      })),
    },
  });
  const contents = yield* encodeSnapshotArtifact({
    version: 1,
    task: input.spec,
    result,
    plan: checks.map((check) => ({
      ...check,
      args: check.args.map(redactEnterpriseSecrets),
    })),
    checks: artifacts,
  });
  if (new TextEncoder().encode(contents).length > MAX_WORKSPACE_FILE_BYTES)
    return yield* new EnterpriseWorkspaceRejected({ reason: "check_failed" });
  yield* writeFileStringAtomically({
    filePath: path.join(controlDir, artifactId),
    contents,
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
  return result;
});
/** Check the bound handoff commit in a detached snapshot so agent checkout changes cannot alter evidence. */
export const gateSnapshot = (
  input: WorkspaceInput & {
    readonly handoff: AgentHandoff;
    readonly checks: ReadonlyArray<Sandbox.EnterpriseCheck>;
  },
) =>
  withOwnership(
    input,
    Effect.fn("EnterpriseWorkspaceService.gateSnapshot")(function* (ctx: OwnershipContext) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secrets = yield* Secrets.EnterpriseSecretService;
      const { repositoryRoot, controlDir } = ctx;
      const ownership = yield* requireOwnership(ctx);
      const handoff = yield* decodeHandoff(input.handoff);
      const checks = yield* decodePlan(input.checks);
      if (
        handoff.taskId !== input.spec.taskId ||
        !ownership.boundThreadIds?.includes(handoff.threadId)
      )
        return yield* new EnterpriseWorkspaceRejected({ reason: "ownership_mismatch" });
      const commitSha = (yield* runGit(repositoryRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${handoff.commitSha}^{commit}`,
      ])).stdout.trim();
      if (commitSha !== handoff.commitSha)
        return yield* new EnterpriseWorkspaceRejected({ reason: "checkout_mismatch" });
      yield* secrets.assertCommitClean({ repositoryRoot, commitSha });
      const tracked = (yield* runGit(repositoryRoot, [
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        commitSha,
      ])).stdout.split("\0");
      if (tracked.some(isSecretPath))
        return yield* new EnterpriseWorkspaceRejected({ reason: "secret_files" });
      /** The agent checkout can keep changing; the fixed snapshot path refuses orphan adoption. */
      const snapshotPath = path.join(controlDir, "snapshot-checkout");
      if (yield* fs.exists(snapshotPath))
        return yield* new EnterpriseWorkspaceRejected({ reason: "allocation_incomplete" });
      const evidence = yield* runSnapshotChecks(
        input,
        repositoryRoot,
        snapshotPath,
        commitSha,
        checks,
      );
      if (yield* fs.exists(snapshotPath))
        return yield* new EnterpriseWorkspaceRejected({ reason: "dirty_worktree" });
      return yield* persistSnapshot(input, controlDir, handoff, checks, commitSha, evidence);
    }),
  );
