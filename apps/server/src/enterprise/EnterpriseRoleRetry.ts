import {
  CommandId,
  EnterpriseLaunchRoleInput,
  EnterpriseRoleError,
  MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isCodexLocalModel } from "../orchestration-v2/Adapters/CodexNamedProfile.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type * as Git from "../vcs/GitVcsDriver.ts";
import type { makeEnterpriseRoleEvidence } from "./EnterpriseRoleEvidence.ts";
import type { makeValidateRoleModel } from "./EnterpriseRoleModel.ts";
import {
  enterpriseRoleRun,
  enterpriseRoleThreadId,
  isEnterpriseRoleMessage,
} from "./EnterpriseRun.ts";
import type * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeInput = Schema.decodeUnknownEffect(EnterpriseLaunchRoleInput);

/**
 * Bounded provider failover for a failed role run: at most two retries, only after a usage-limit
 * or explicit retryable 429/503/529 error, only on a different model of the same backend, and only
 * when the checkout still matches the run's starting snapshot. The retry re-sends the original
 * prompt through V2, so it never consumes a QA correction round.
 */
export const makeEnterpriseRoleRetry = (deps: {
  readonly git: Git.GitVcsDriver["Service"];
  readonly workspace: Workspace.EnterpriseWorkspaceService["Service"];
  readonly threads: Threads.ThreadManagementService["Service"];
  readonly evidence: ReturnType<typeof makeEnterpriseRoleEvidence>;
  readonly validateModel: ReturnType<typeof makeValidateRoleModel>;
}) => {
  const { git, workspace, threads, evidence, validateModel } = deps;
  return Effect.fn("EnterpriseRoleService.retry")(function* (raw: EnterpriseLaunchRoleInput) {
    const input = yield* decodeInput(raw);
    yield* validateModel(input.modelSelection);
    const owned = yield* workspace.prepare({ ...input, spec: input.task });
    const identity = owned.branch.slice("enterprise/task-".length);
    const revision = input.revision ?? 0;
    const threadId = enterpriseRoleThreadId(identity, input.role, revision);
    if (owned.retired || !owned.boundThreadIds?.includes(threadId))
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const projection = yield* threads.getProjectThread({
      projectId: input.task.projectId,
      threadId,
    });
    const run = enterpriseRoleRun(projection, threadId);
    const retries = projection.runs.filter(
      (candidate) => candidate.userMessageId !== `${threadId}:initial`,
    );
    const failure = projection.turnItems?.findLast(
      (item) => item.type === "error" && item.runId === run?.id,
    );
    if (
      projection.thread.worktreePath !== owned.worktreePath ||
      projection.thread.deletedAt !== null ||
      projection.thread.archivedAt !== null ||
      run?.status !== "failed" ||
      retries.length >= 2 ||
      projection.runs.some(
        (candidate) =>
          !isEnterpriseRoleMessage(threadId, candidate.userMessageId) ||
          !Threads.isTerminalRunStatus(candidate.status),
      ) ||
      failure?.type !== "error" ||
      !(
        failure.failure.class === "usage_limit" ||
        (failure.failure.retryable === true &&
          /^(?:http[_-])?(?:429|503|529)$/.test(failure.failure.code ?? ""))
      ) ||
      isCodexLocalModel(run.modelSelection.model) !==
        isCodexLocalModel(input.modelSelection.model) ||
      run.modelSelection.model === input.modelSelection.model
    )
      return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const status = yield* git.execute({
      operation: "EnterpriseRoleService.retryStatus",
      cwd: owned.worktreePath,
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
      ],
    });
    if (status.stdout.trim()) return yield* new EnterpriseRoleError({ reason: "workspace_in_use" });
    const expectedStart =
      input.role === "architect"
        ? input.task.repoCommit
        : (yield* evidence.collectHandoff({
            ...input,
            role: input.role === "qa" || revision > 0 ? "coder" : "architect",
            revision: input.role === "qa" ? revision : revision === 0 ? 0 : revision === 1 ? 0 : 1,
          })).commitSha;
    const unchanged = yield* git.execute({
      operation: "EnterpriseRoleService.retryTree",
      cwd: owned.worktreePath,
      args: ["-c", "core.hooksPath=/dev/null", "diff", "--quiet", expectedStart, "HEAD"],
      allowNonZeroExit: true,
    });
    if (unchanged.exitCode !== 0)
      return yield* new EnterpriseRoleError({ reason: "workspace_in_use" });
    const original = projection.messages.find((message) => message.id === `${threadId}:initial`);
    if (!original?.text) return yield* new EnterpriseRoleError({ reason: "request_mismatch" });
    const messageId = MessageId.make(`${threadId}:provider-retry:${retries.length + 1}`);
    yield* threads.dispatch({
      type: "message.dispatch",
      threadId,
      commandId: CommandId.make(`${messageId}:dispatch`),
      messageId,
      text: original.text,
      attachments: [],
      modelSelection: input.modelSelection,
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    });
    return { threadId };
  });
};
