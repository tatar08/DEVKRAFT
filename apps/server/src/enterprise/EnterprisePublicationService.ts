import {
  EnterprisePublicationError,
  EnterprisePublishedPullRequest,
  EnterprisePublishPullRequestInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Runner from "../processRunner.ts";
import * as Workflow from "./EnterpriseWorkflowService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import { enterpriseTaskKey } from "./EnterpriseWorkflowConfiguration.ts";

const decodeInput = Schema.decodeUnknownEffect(EnterprisePublishPullRequestInput);
const decodeResult = Schema.decodeUnknownEffect(EnterprisePublishedPullRequest);
const RemotePr = Schema.Struct({
  number: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  url: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  baseRefName: Schema.String,
  isDraft: Schema.Boolean,
  isCrossRepository: Schema.Boolean,
  state: Schema.String,
});
const decodePrs = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RemotePr)));
/**
 * Persisted immediately before the non-idempotent `gh pr create`. Its presence means a create may
 * have happened, so an unreconciled retry stops at `publication_unknown` instead of replaying.
 */
const Receipt = Schema.Struct({
  repository: Schema.String,
  baseBranch: Schema.String,
  headBranch: Schema.String,
  commitSha: Schema.String,
});
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(Receipt));

export class EnterprisePublicationService extends Context.Service<
  EnterprisePublicationService,
  {
    /**
     * Publishes the workflow's verified checkpoint as a draft PR on a deterministic branch.
     * Never advances the workflow, merges or approves; retries reconcile against GitHub first.
     *
     * After a process crash, a held `publication.lock` remains busy regardless of age. To recover,
     * first stop/confirm the publishing process is no longer running and inspect GitHub for the
     * receipt's repository and head branch. Remove only the task control directory's
     * `publication.lock`, preserving `publication.json`, then retry the identical publish request.
     * The receipt prevents another create: retry returns the matching PR or `publication_unknown`.
     * If unknown, investigate GitHub/gh and retry reconciliation; do not delete the receipt to
     * force creation, since the original request may already have created a PR.
     */
    readonly publish: (
      input: EnterprisePublishPullRequestInput,
    ) => Effect.Effect<EnterprisePublishedPullRequest, EnterprisePublicationError>;
  }
>()("t3/enterprise/EnterprisePublicationService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const workflow = yield* Workflow.EnterpriseWorkflowService;
  const workspace = yield* Workspace.EnterpriseWorkspaceService;
  const git = yield* Git.GitVcsDriver;
  const runner = yield* Runner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const publish = Effect.fn("EnterprisePublicationService.publish")(function* (
    raw: EnterprisePublishPullRequestInput,
  ) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError(
        (cause) => new EnterprisePublicationError({ reason: "invalid_input", cause }),
      ),
    );
    // Verification re-runs the gate but never dispatches provider work on the publisher's behalf.
    const state = yield* workflow
      .verify(input.workflow)
      .pipe(
        Effect.mapError(
          (cause) => new EnterprisePublicationError({ reason: "workflow_not_ready", cause }),
        ),
      );
    if (state.state !== "ready")
      return yield* new EnterprisePublicationError({ reason: "workflow_not_ready" });
    const owned = yield* workspace.prepare({ ...input.workflow, spec: input.workflow.task });
    const control = path.dirname(owned.worktreePath);
    const commitSha = state.draft.evidence.diffSha;
    const taskKey = yield* enterpriseTaskKey(input.workflow.task);
    const headBranch = `enterprise/pr-${taskKey}-${commitSha}`;
    const receiptPath = path.join(control, "publication.json");
    const receipt = {
      repository: input.repository,
      baseBranch: input.baseBranch,
      headBranch,
      commitSha,
    };
    const lock = path.join(control, "publication.lock");
    return yield* Effect.acquireUseRelease(
      fs.makeDirectory(lock).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.fail(
              new EnterprisePublicationError({
                reason: cause.reason._tag === "AlreadyExists" ? "busy" : "storage_failed",
                cause,
              }),
            ),
        }),
      ),
      () =>
        Effect.gen(function* () {
          const previous = (yield* fs.exists(receiptPath))
            ? yield* fs.readFileString(receiptPath).pipe(Effect.flatMap(decodeReceipt))
            : undefined;
          if (
            previous !== undefined &&
            (previous.repository !== receipt.repository ||
              previous.baseBranch !== receipt.baseBranch ||
              previous.headBranch !== headBranch ||
              previous.commitSha !== commitSha)
          )
            return yield* new EnterprisePublicationError({ reason: "request_mismatch" });
          const runGit = (args: ReadonlyArray<string>) =>
            git.execute({
              operation: "EnterprisePublicationService.git",
              cwd: input.workflow.repositoryRoot,
              args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
              allowNonZeroExit: true,
              timeoutMs: 30_000,
              maxOutputBytes: 65_536,
            });
          const ref = yield* runGit(["check-ref-format", `refs/heads/${input.baseBranch}`]);
          if (ref.exitCode !== 0)
            return yield* new EnterprisePublicationError({ reason: "invalid_input" });
          const config = yield* runGit([
            "config",
            "--local",
            "--get-regexp",
            "^(url\\.|credential\\.|http\\.|include|core\\.(sshcommand|gitproxy)|protocol\\.)",
          ]);
          if (config.exitCode === 0)
            return yield* new EnterprisePublicationError({ reason: "unsafe_git_config" });
          if (config.exitCode !== 1)
            return yield* new EnterprisePublicationError({ reason: "remote_failed" });
          const gh = (args: ReadonlyArray<string>) =>
            runner
              .run({
                command: "gh",
                args,
                cwd: control,
                timeout: "30 seconds",
                maxOutputBytes: 262_144,
              })
              .pipe(
                Effect.flatMap((output) =>
                  output.code === 0 &&
                  !output.timedOut &&
                  !output.stdoutTruncated &&
                  !output.stdoutInvalidUtf8
                    ? Effect.succeed(output)
                    : Effect.fail(new EnterprisePublicationError({ reason: "remote_failed" })),
                ),
              );
          const reconcile = Effect.fn("EnterprisePublicationService.reconcile")(function* () {
            const output = yield* gh([
              "pr",
              "list",
              "--repo",
              input.repository,
              "--head",
              headBranch,
              "--state",
              "all",
              "--limit",
              "100",
              "--json",
              "number,url,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,state",
            ]);
            const prs = yield* decodePrs(output.stdout);
            if (prs.length > 1)
              return yield* new EnterprisePublicationError({ reason: "remote_mismatch" });
            const pr = prs[0];
            if (pr === undefined) return undefined;
            const expectedUrl = `https://github.com/${input.repository}/pull/${pr.number}`;
            if (
              pr.url !== expectedUrl ||
              pr.headRefName !== headBranch ||
              pr.headRefOid !== commitSha ||
              pr.baseRefName !== input.baseBranch ||
              !pr.isDraft ||
              pr.isCrossRepository ||
              pr.state !== "OPEN"
            )
              return yield* new EnterprisePublicationError({ reason: "remote_mismatch" });
            return yield* decodeResult({
              url: pr.url,
              number: pr.number,
              commitSha,
              headBranch,
              reconciled: true,
            });
          });
          const found = yield* reconcile();
          if (found !== undefined) return found;
          if (previous !== undefined)
            return yield* new EnterprisePublicationError({ reason: "publication_unknown" });
          // Only the verified checkpoint can be uploaded, to a new deterministic branch.
          const remote = `https://github.com/${input.repository}.git`;
          const remoteRef = `refs/heads/${headBranch}`;
          const heads = yield* runGit(["ls-remote", "--refs", remote, remoteRef]);
          if (heads.exitCode !== 0)
            return yield* new EnterprisePublicationError({ reason: "remote_failed" });
          if (heads.stdout.trim() !== "" && heads.stdout.trim() !== `${commitSha}\t${remoteRef}`)
            return yield* new EnterprisePublicationError({ reason: "remote_mismatch" });
          if (heads.stdout.trim() === "") {
            const pushed = yield* runGit([
              "push",
              "--porcelain",
              `--force-with-lease=${remoteRef}:`,
              remote,
              `${commitSha}:${remoteRef}`,
            ]);
            if (pushed.exitCode !== 0)
              return yield* new EnterprisePublicationError({ reason: "remote_failed" });
          }
          // Commit intent before the non-idempotent API call. Crash recovery reconciles by branch.
          yield* writeFileStringAtomically({
            filePath: receiptPath,
            contents: yield* encodeReceipt(receipt),
          });
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-enterprise-pr-" });
              const bodyPath = path.join(tmp, "body.md");
              yield* fs.writeFileString(bodyPath, state.draft.body);
              const create = yield* gh([
                "pr",
                "create",
                "--repo",
                input.repository,
                "--base",
                input.baseBranch,
                "--head",
                headBranch,
                "--draft",
                "--title",
                `feat: enterprise task ${taskKey.slice(0, 12)}`,
                "--body-file",
                bodyPath,
              ]);
              const created = yield* reconcile();
              if (created !== undefined) return { ...created, reconciled: false };
              // GitHub search can lag behind a successful create; trust only the exact URL gh printed.
              const prefix = `https://github.com/${input.repository}/pull/`;
              const printed = create.stdout.trim();
              const number = printed.startsWith(prefix) ? printed.slice(prefix.length) : "";
              if (!/^[1-9]\d*$/.test(number))
                return yield* new EnterprisePublicationError({ reason: "publication_unknown" });
              return yield* decodeResult({
                url: printed,
                number: Number(number),
                commitSha,
                headBranch,
                reconciled: false,
              });
            }),
          );
        }),
      () => fs.remove(lock, { recursive: true }).pipe(Effect.orDie),
    );
  });
  return EnterprisePublicationService.of({
    publish: (input) =>
      publish(input).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) =>
          cause._tag === "EnterprisePublicationError"
            ? cause
            : new EnterprisePublicationError({ reason: "remote_failed", cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(EnterprisePublicationService, make);
