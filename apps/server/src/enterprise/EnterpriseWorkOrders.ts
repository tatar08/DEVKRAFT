import {
  EnterpriseRoleError,
  EnterpriseWorkOrderList,
  type EnterpriseRole,
  type EnterpriseWorkOrder,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Publication from "./EnterprisePublicationService.ts";
import {
  enterpriseRoleRun,
  enterpriseRoleThreadId,
  type EnterpriseRevision,
} from "./EnterpriseRun.ts";
import { EnterpriseTenancy } from "./EnterpriseTenancy.ts";
import * as Automation from "./EnterpriseWorkflowAutomation.ts";
import {
  deriveEnterpriseWorkOrderStage,
  type EnterpriseRoleRunSummary,
} from "./EnterpriseWorkOrderStage.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeList = Schema.decodeUnknownEffect(EnterpriseWorkOrderList);
/** Issue context written by `startIssueWorkflow`; anything else falls back to the task ID. */
const decodeIssueContext = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ issue: Schema.Struct({ title: Schema.String, url: Schema.String }) }),
  ),
);
const ROLE_SLOTS: ReadonlyArray<{ role: EnterpriseRole; revision: EnterpriseRevision }> = [
  { role: "architect", revision: 0 },
  { role: "coder", revision: 0 },
  { role: "qa", revision: 0 },
  { role: "coder", revision: 1 },
  { role: "qa", revision: 1 },
  { role: "coder", revision: 2 },
  { role: "qa", revision: 2 },
];
const MAX_TITLE = 512;

/**
 * Read model for the Phase 5 cockpit. Everything comes from records that already exist: V2 role
 * threads, the automation registration, stored approvals and the publication receipt. It never
 * re-runs a gate or dispatches work, so it is safe to poll. Approval counts are stored decisions;
 * the authoritative decision is `enterprise.getApproval`, which revalidates.
 */
export class EnterpriseWorkOrders extends Context.Service<
  EnterpriseWorkOrders,
  {
    readonly list: Effect.Effect<EnterpriseWorkOrderList, EnterpriseRoleError>;
  }
>()("t3/enterprise/EnterpriseWorkOrders") {}

const make = Effect.gen(function* () {
  const automation = yield* Automation.EnterpriseWorkflowAutomation;
  const threads = yield* Threads.ThreadManagementService;
  const workspace = yield* Workspace.EnterpriseWorkspaceService;
  const publication = yield* Publication.EnterprisePublicationService;
  const tenancy = yield* EnterpriseTenancy;
  const path = yield* Path.Path;

  const describe = Effect.fn("EnterpriseWorkOrders.describe")(function* (
    entry: Effect.Success<typeof automation.registrations>[number],
    updatedAtByThread: ReadonlyMap<string, DateTime.Utc>,
  ) {
    const { record, architect } = entry;
    const workflow = record.input;
    const key = architect.id.split(":")[1]!;
    const runs: Array<EnterpriseRoleRunSummary> = [];
    let updatedAt: DateTime.Utc | undefined;
    for (const slot of ROLE_SLOTS) {
      const threadId = enterpriseRoleThreadId(key, slot.role, slot.revision);
      const projection = yield* threads
        .getProjectThread({ projectId: workflow.task.projectId, threadId })
        .pipe(Effect.orElseSucceed(() => undefined));
      const run = projection === undefined ? undefined : enterpriseRoleRun(projection, threadId);
      if (run !== undefined) runs.push({ ...slot, threadId, status: run.status });
      const touched = updatedAtByThread.get(threadId);
      if (
        touched !== undefined &&
        (updatedAt === undefined || DateTime.isGreaterThan(touched, updatedAt))
      )
        updatedAt = touched;
    }
    const controlDir = path.dirname(architect.worktreePath!);
    const pullRequest = yield* publication.published({ controlDir });
    const stored = yield* workspace
      .readApprovals({
        spec: workflow.task,
        repositoryRoot: workflow.repositoryRoot,
        workspacesRoot: workflow.workspacesRoot,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    const sessionsWith = (decision: "approve" | "reject") =>
      new Set(
        (stored?.entries ?? [])
          .filter((approval) => approval.decision === decision)
          .map((approval) => approval.sessionId),
      ).size;
    const { stage, activeRole } = deriveEnterpriseWorkOrderStage({
      record,
      runs,
      pullRequestOpened: pullRequest !== undefined,
    });
    const issue = decodeIssueContext(workflow.issueContext);
    return {
      key,
      title: (issue._tag === "Some" ? issue.value.issue.title : workflow.task.taskId).slice(
        0,
        MAX_TITLE,
      ),
      issueUrl: issue._tag === "Some" ? issue.value.issue.url : null,
      stage,
      activeRole:
        activeRole === null
          ? null
          : { role: activeRole.role, revision: activeRole.revision, threadId: activeRole.threadId },
      stopReason: record.stopReason,
      automationEnabled: record.enabled,
      approvals: { approve: sessionsWith("approve"), reject: sessionsWith("reject") },
      pullRequest: pullRequest ?? null,
      updatedAt: updatedAt === undefined ? null : DateTime.formatIso(updatedAt),
      workflow,
    } satisfies EnterpriseWorkOrder;
  });

  const list = Effect.gen(function* () {
    const registrations = yield* automation.registrations;
    const shell = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(
        Effect.mapError((cause) => new EnterpriseRoleError({ reason: "launch_failed", cause })),
      );
    const updatedAtByThread = new Map(
      shell.threads.map((thread) => [
        thread.id as string,
        thread.latestRunCompletedAt ?? thread.latestRunStartedAt ?? thread.createdAt,
      ]),
    );
    const workOrders: Array<EnterpriseWorkOrder> = [];
    for (const entry of registrations) {
      // The cockpit only shows tenants this environment serves (ADR-003).
      const allowed = yield* tenancy.authorize(entry.record.input.task.tenantId).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!allowed) continue;
      workOrders.push(
        yield* describe(entry, updatedAtByThread).pipe(
          Effect.mapError((cause) => new EnterpriseRoleError({ reason: "launch_failed", cause })),
        ),
      );
    }
    return yield* decodeList({
      workOrders: workOrders.toSorted((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
      ),
    }).pipe(
      Effect.mapError((cause) => new EnterpriseRoleError({ reason: "invalid_output", cause })),
    );
  });

  return EnterpriseWorkOrders.of({ list });
});

export const layer = Layer.effect(EnterpriseWorkOrders, make);
