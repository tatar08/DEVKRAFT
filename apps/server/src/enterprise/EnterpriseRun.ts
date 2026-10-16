import {
  ThreadId,
  type EnterpriseRole,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** Correction round: 0 is the initial pass, 1–2 are the bounded fix rounds. */
export type EnterpriseRevision = 0 | 1 | 2;

const ROLE_THREAD_ID = /^enterprise:[a-f0-9]{64}:(?:fix[12]:)?(?:architect|coder|qa)$/;

/**
 * The single source of truth for Enterprise role thread identity. Runtime policy recognises role
 * threads by this shape, so every producer must build IDs here.
 */
export const enterpriseRoleThreadId = (
  identity: string,
  role: EnterpriseRole,
  revision: EnterpriseRevision,
) => ThreadId.make(`enterprise:${identity}:${revision === 0 ? "" : `fix${revision}:`}${role}`);

export const isEnterpriseRoleThreadId = (threadId: string) => ROLE_THREAD_ID.test(threadId);

/** Coder threads (initial and fix rounds) are the only role threads granted write access. */
export const isEnterpriseCoderThreadId = (threadId: string) =>
  isEnterpriseRoleThreadId(threadId) && threadId.endsWith(":coder");

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
