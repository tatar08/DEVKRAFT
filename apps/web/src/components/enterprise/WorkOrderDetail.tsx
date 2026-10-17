import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnterpriseApprovalError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import type {
  EnterpriseApprovalStatus,
  EnterpriseMergeCheckResult,
  EnterpriseWorkOrder,
  EnvironmentId,
} from "@t3tools/contracts";
import { enterpriseEnvironment } from "~/state/enterprise";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { requestConfirmDialog } from "~/confirmDialog";
import { openPreviewSession } from "~/components/preview/openPreviewSession";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "~/components/ui/dialog";
import { useRightPanelStore } from "~/rightPanelStore";
import { blockerMessage, coderTarget, mergeCheckMatches } from "./workOrders.logic";

/** Evidence is revalidated on demand, never by the board's background refresh. */
export function WorkOrderDetail({
  order,
  environmentId,
  connected,
  onClose,
  onChanged,
}: {
  order: EnterpriseWorkOrder;
  environmentId: EnvironmentId;
  connected: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  // Tag replies with their original context so a late response cannot revive stale evidence.
  const [context, setContext] = useState({ connected, updatedAt: order.updatedAt });
  if (context.connected !== connected || context.updatedAt !== order.updatedAt) {
    setContext({ connected, updatedAt: order.updatedAt });
  }
  const [approvalReceipt, setApprovalReceipt] = useState<{
    context: typeof context;
    value: EnterpriseApprovalStatus;
  } | null>(null);
  const [checkReceipt, setCheckReceipt] = useState<{
    context: typeof context;
    value: EnterpriseMergeCheckResult;
    checkedAt: number;
  } | null>(null);
  const approval = approvalReceipt?.context === context ? approvalReceipt.value : null;
  const mergeCheck = checkReceipt?.context === context ? checkReceipt.value : null;
  const setApproval = (value: EnterpriseApprovalStatus | null) =>
    setApprovalReceipt(value ? { context, value } : null);
  const setMergeCheck = (value: EnterpriseMergeCheckResult | null) =>
    setCheckReceipt(value ? { context, value, checkedAt: Date.now() } : null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [repository, setRepository] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [targetBranch, setTargetBranch] = useState("main");
  const lock = useRef(false);
  const navigate = useNavigate();
  const getApproval = useAtomCommand(enterpriseEnvironment.getApproval);
  const recordApproval = useAtomCommand(enterpriseEnvironment.recordApproval);
  const publish = useAtomCommand(enterpriseEnvironment.publishPullRequest);
  const check = useAtomCommand(enterpriseEnvironment.checkMerge);
  const merge = useAtomCommand(enterpriseEnvironment.mergeTask);
  const cancel = useAtomCommand(enterpriseEnvironment.cancelWorkflow);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const canRead = useAtomValue(enterpriseEnvironment.getApproval.permissionAtom(environmentId));
  const canDecide = useAtomValue(
    enterpriseEnvironment.recordApproval.permissionAtom(environmentId),
  );
  const canPublish = useAtomValue(
    enterpriseEnvironment.publishPullRequest.permissionAtom(environmentId),
  );
  const canCheck = useAtomValue(enterpriseEnvironment.checkMerge.permissionAtom(environmentId));
  const canMerge = useAtomValue(enterpriseEnvironment.mergeTask.permissionAtom(environmentId));
  const canCancel = useAtomValue(
    enterpriseEnvironment.cancelWorkflow.permissionAtom(environmentId),
  );
  const canPreview = useAtomValue(previewEnvironment.open.permissionAtom(environmentId));
  const commonReason = !connected
    ? "Environment disconnected."
    : busy
      ? "An action is in progress."
      : null;
  const evidenceReason = !approval ? "Refresh to load verified evidence." : null;
  const coder = coderTarget(order, approval?.evidence.provenance.threadId);
  const coderThread = coder?.threadId;

  async function run(action: () => Promise<void>) {
    if (lock.current || !connected) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    setMergeCheck(null);
    setApproval(null);
    const result = await getApproval({ environmentId, input: { workflow: order.workflow } });
    if (result._tag === "Success") setApproval(result.value);
    else
      setMessage(
        isApprovalBusy(squashAtomCommandFailure(result))
          ? "Another operation is running. Try Refresh in a moment."
          : "Could not revalidate evidence. Retry Refresh.",
      );
  }
  const open = useEffectEvent(() => {
    if (connected && canRead) void run(refresh);
  });
  useEffect(() => {
    open();
  }, []);

  async function decide(decision: "approve" | "reject") {
    if (
      decision === "reject" &&
      (await requestConfirmDialog("Reject these verified changes?")) !== true
    )
      return;
    const result = await recordApproval({
      environmentId,
      input: { workflow: order.workflow, decision },
    });
    setMergeCheck(null);
    if (result._tag === "Success") {
      setApproval(result.value);
      setMessage("Decision recorded.");
      onChanged();
    } else {
      setApproval(null);
      setMessage(
        isApprovalBusy(squashAtomCommandFailure(result))
          ? "Another operation is running. Try Refresh in a moment."
          : "Decision was not recorded. Refresh and try again.",
      );
    }
  }
  const mergeReason =
    evidenceReason ??
    (approval?.blockers.length ? "Resolve the approval blockers first." : null) ??
    (!mergeCheckMatches(
      mergeCheck,
      targetBranch,
      approval?.evidence.diffSha,
      checkReceipt?.checkedAt,
    )
      ? "Run Check merge for this branch and verified commit first."
      : null);
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{order.title}</DialogTitle>
          <DialogDescription>Proof of Work · {order.workflow.task.taskId}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {message ? <p role="status">{message}</p> : null}
          <Action
            label="Refresh"
            reason={commonReason ?? (!canRead ? "Approval access is required." : null)}
            onClick={() => void run(refresh)}
          />
          {approval ? (
            <Evidence approval={approval} budget={order.workflow.task.budgetLimit.limitCents} />
          ) : (
            <p>Evidence is unavailable until revalidation succeeds.</p>
          )}
          <h3 className="font-medium">Human decision</h3>
          <div className="flex flex-wrap gap-3">
            {(["approve", "reject"] as const).map((decision) => (
              <Action
                key={decision}
                label={decision === "approve" ? "Approve" : "Reject"}
                reason={
                  commonReason ?? (!canDecide ? "Approval permission is required." : evidenceReason)
                }
                onClick={() => void run(() => decide(decision))}
              />
            ))}
          </div>
          <h3 className="font-medium">Draft pull request</h3>
          <label className="block">
            Repository (OWNER/REPO)
            <Input
              disabled={busy}
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            />
          </label>
          <label className="block">
            Base branch
            <Input
              disabled={busy}
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
            />
          </label>
          <Action
            label="Publish draft PR"
            reason={
              commonReason ??
              (!canPublish
                ? "Publication permission is required."
                : order.pullRequest
                  ? "A pull request is already recorded."
                  : (evidenceReason ??
                    (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !baseBranch.trim()
                      ? "Enter a repository and base branch."
                      : null)))
            }
            onClick={() =>
              void run(async () => {
                const result = await publish({
                  environmentId,
                  input: { workflow: order.workflow, repository, baseBranch },
                });
                setMergeCheck(null);
                if (result._tag === "Success") {
                  setMessage(`Draft PR: ${result.value.url}`);
                  onChanged();
                } else setMessage("Publication failed. Refresh before retrying.");
              })
            }
          />
          <h3 className="font-medium">Local merge</h3>
          <label className="block">
            Target branch
            <Input
              disabled={busy}
              value={targetBranch}
              onChange={(event) => {
                setTargetBranch(event.target.value);
                setMergeCheck(null);
              }}
            />
          </label>
          <Action
            label="Check merge"
            reason={
              commonReason ??
              (!canCheck
                ? "Merge check permission is required."
                : (evidenceReason ??
                  (!coder
                    ? "Verified Coder revision is unavailable."
                    : !targetBranch.trim()
                      ? "Enter a target branch."
                      : null)))
            }
            onClick={() =>
              void run(async () => {
                setMergeCheck(null);
                const result = await check({
                  environmentId,
                  input: {
                    task: order.workflow.task,
                    repositoryRoot: order.workflow.repositoryRoot,
                    workspacesRoot: order.workflow.workspacesRoot,
                    ...(coder ? { revision: coder.revision } : {}),
                    targetBranch,
                  },
                });
                if (result._tag === "Success") {
                  setMergeCheck(result.value);
                  setMessage("Merge check passed.");
                } else setMessage("Merge check failed.");
              })
            }
          />
          {mergeCheck ? (
            <p className="break-all text-sm">Checked target: {mergeCheck.targetCommit}</p>
          ) : null}
          <Action
            label="Merge"
            reason={commonReason ?? (!canMerge ? "Merge permission is required." : mergeReason)}
            onClick={() =>
              void run(async () => {
                if (
                  !mergeCheck ||
                  !approval ||
                  approval.blockers.length ||
                  !mergeCheckMatches(
                    mergeCheck,
                    targetBranch,
                    approval.evidence.diffSha,
                    checkReceipt?.checkedAt,
                  )
                )
                  return;
                if (
                  (await requestConfirmDialog(
                    `Merge into ${targetBranch}? This moves a local branch and never pushes.`,
                  )) !== true
                )
                  return;
                if (
                  !mergeCheckMatches(
                    mergeCheck,
                    targetBranch,
                    approval.evidence.diffSha,
                    checkReceipt?.checkedAt,
                  )
                ) {
                  setMergeCheck(null);
                  setMessage("The merge check expired. Run Check merge again.");
                  return;
                }
                const result = await merge({
                  environmentId,
                  input: {
                    workflow: order.workflow,
                    targetBranch,
                    expectedTargetCommit: mergeCheck.targetCommit,
                  },
                });
                setMergeCheck(null);
                setApproval(null);
                setMessage(
                  result._tag === "Success"
                    ? "Local branch merged. Nothing was pushed."
                    : "Merge failed. Refresh evidence and check the target again.",
                );
                onChanged();
              })
            }
          />
          <Action
            label="Cancel workflow"
            reason={
              commonReason ??
              (!canCancel
                ? "Workflow permission is required."
                : !order.automationEnabled
                  ? "The workflow is already stopped."
                  : null)
            }
            onClick={() =>
              void run(async () => {
                if (
                  (await requestConfirmDialog(
                    "Cancel this workflow? Running provider work will be asked to stop.",
                  )) !== true
                )
                  return;
                const result = await cancel({ environmentId, input: order.workflow });
                setMergeCheck(null);
                setApproval(null);
                setMessage(
                  result._tag === "Success" ? "Cancellation requested." : "Cancellation failed.",
                );
                onChanged();
              })
            }
          />
          <h3 className="font-medium">Task checkout</h3>
          {coderThread ? (
            <Link
              className="inline-flex min-h-11 items-center underline"
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: coderThread }}
            >
              Open in T3
            </Link>
          ) : (
            <p>The Coder thread is not available yet.</p>
          )}
          <p className="text-sm text-muted-foreground">
            Preview runs a dev server on the host, outside the check sandbox. Start it only for code
            you trust.
          </p>
          <Action
            label="Preview"
            reason={
              commonReason ??
              (!canPreview
                ? "Preview permission is required."
                : !coderThread
                  ? "The Coder thread is not available yet."
                  : null)
            }
            onClick={() =>
              void run(async () => {
                if (!coderThread) return;
                const result = await openPreviewSession({
                  openPreview,
                  threadRef: { environmentId, threadId: coderThread },
                });
                if (result._tag === "Success") {
                  useRightPanelStore
                    .getState()
                    .openBrowser({ environmentId, threadId: coderThread }, result.value.tabId);
                  await navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId: coderThread },
                  });
                } else setMessage("Could not open preview.");
              })
            }
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function Action({
  label,
  reason,
  onClick,
}: {
  label: string;
  reason: string | null;
  onClick: () => void;
}) {
  return (
    <div className="space-y-1">
      <Button size="xl" variant="outline" disabled={reason !== null} onClick={onClick}>
        {label}
      </Button>
      {reason ? (
        <p className="text-xs text-muted-foreground">
          {label}: {reason}
        </p>
      ) : null}
    </div>
  );
}

function Evidence({
  approval: { evidence, risk, blockers, requiredApprovers, ignored },
  budget,
}: {
  approval: EnterpriseApprovalStatus;
  budget: number;
}) {
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium">Verified evidence</h3>
      <p className="break-all">Commit: {evidence.diffSha}</p>
      <ul>
        {[...evidence.tests, evidence.securityScan].map((check) => (
          <li key={`${check.kind}:${check.name}:${check.commitSha}`}>
            {check.name} ({check.kind}): {check.status.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
      <p>
        Cost:{" "}
        {evidence.cost.amountCents === null
          ? "unknown"
          : `$${(evidence.cost.amountCents / 100).toFixed(2)}`}{" "}
        / ${(budget / 100).toFixed(2)} budget
      </p>
      <p>
        Risk tier: {risk.tier} · {risk.decision}
      </p>
      <p>Critical changes: {risk.criticalChanges.join(", ") || "None"}</p>
      <p>Matched rules: {risk.matchedRules.join(", ") || "None"}</p>
      <p>
        Counted approvers: {risk.approvers.length} / {requiredApprovers} required
      </p>
      <h4>Ignored decisions</h4>
      {ignored.length ? (
        <ul>
          {ignored.map((entry) => (
            <li key={`${entry.sessionId}:${entry.reason}`}>
              {entry.sessionId}: {ignoredReason(entry.reason)}
            </li>
          ))}
        </ul>
      ) : (
        <p>None</p>
      )}
      <h4>Blockers</h4>
      {blockers.length ? (
        <ul>
          {blockers.map((blocker) => (
            <li key={blocker}>{blockerMessage[blocker]}</li>
          ))}
        </ul>
      ) : (
        <p>No approval blockers.</p>
      )}
    </div>
  );
}

function ignoredReason(reason: string): ReactNode {
  return (
    {
      stale_diff: "The verified changes have changed.",
      policy_changed: "The policy has changed.",
      expired: "The decision expired.",
      session_invalid: "The deciding session is no longer valid.",
    }[reason] ?? reason
  );
}

const isApprovalError = Schema.is(EnterpriseApprovalError);

/** Contention is retryable and must not look like invalid evidence. */
function isApprovalBusy(error: unknown) {
  return isApprovalError(error) && error.reason === "busy";
}
