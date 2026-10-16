import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";

/** Only initial work and the two server-managed provider retries belong to this role. */
export const isEnterpriseRoleMessage = (threadId: ThreadId, messageId: string) =>
  messageId === `${threadId}:initial` ||
  messageId === `${threadId}:provider-retry:1` ||
  messageId === `${threadId}:provider-retry:2`;

export const enterpriseRoleRun = (
  projection: OrchestrationV2ThreadProjection,
  threadId: ThreadId,
) => projection.runs.findLast((run) => isEnterpriseRoleMessage(threadId, run.userMessageId));

export const isDocumentationPath = (path: string) =>
  /\.(?:md|mdx|rst|txt)$/i.test(path) && !/(?:^|\/)(?:\.git|\.codex|\.agents)(?:\/|$)/.test(path);
