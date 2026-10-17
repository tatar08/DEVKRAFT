import { useAtomValue } from "@effect/atom-react";
import type {
  EnterpriseApprovalStatus,
  EnterpriseWorkOrder,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { enterpriseEnvironment } from "../../state/enterprise";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { ApprovalEvidence } from "./ApprovalEvidence";
import { decisionReason } from "./approvals.logic";

/** Revalidate on open or explicit refresh; list polling must never rerun the gate. */
export function ApprovalDetail({
  order,
  environmentId,
  connected,
  onChanged,
}: {
  order: EnterpriseWorkOrder;
  environmentId: EnvironmentId;
  connected: boolean;
  onChanged: () => void;
}) {
  const getApproval = useAtomCommand(enterpriseEnvironment.getApproval);
  const recordApproval = useAtomCommand(enterpriseEnvironment.recordApproval);
  const canRead = useAtomValue(enterpriseEnvironment.getApproval.permissionAtom(environmentId));
  const canDecide = useAtomValue(
    enterpriseEnvironment.recordApproval.permissionAtom(environmentId),
  );
  const [context, setContext] = useState({ connected, updatedAt: order.updatedAt });
  if (context.connected !== connected || context.updatedAt !== order.updatedAt) {
    setContext({ connected, updatedAt: order.updatedAt });
  }
  const [receipt, setReceipt] = useState<{
    context: typeof context;
    value: EnterpriseApprovalStatus;
  } | null>(null);
  const approval = receipt?.context === context ? receipt.value : null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const reason = decisionReason(connected, canDecide, busy, approval !== null);
  const current = useRef<{ context: typeof context | null; reason: string | null }>({
    context,
    reason,
  });
  useLayoutEffect(() => {
    current.current = { context, reason };
    return () => {
      current.current = { context: null, reason: "Detail closed." };
    };
  }, [context, reason]);

  async function run(decision?: "approve" | "reject") {
    if (lock.current || !connected || (decision ? reason !== null : !canRead)) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    setReceipt(null);
    try {
      const result = decision
        ? await recordApproval({ environmentId, input: { workflow: order.workflow, decision } })
        : await getApproval({ environmentId, input: { workflow: order.workflow } });
      if (current.current.context !== context) return;
      if (result._tag === "Success") {
        setReceipt({ context, value: result.value });
        if (decision) {
          setMessage("Decision recorded by the environment.");
          onChanged();
        }
      } else
        setMessage(
          decision
            ? "Decision was not acknowledged. Refresh evidence before retrying."
            : "Could not revalidate evidence. Try Refresh.",
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const open = useEffectEvent(() => {
    void run();
  });
  useEffect(() => {
    open();
  }, []);

  function reject() {
    if (reason !== null) return;
    Alert.alert("Reject these verified changes?", "This records a rejection for this task.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reject",
        style: "destructive",
        onPress: () => {
          if (current.current.context === context && current.current.reason === null)
            void run("reject");
        },
      },
    ]);
  }
  const refreshReason = !connected
    ? "Environment disconnected."
    : busy
      ? "An action is in progress."
      : !canRead
        ? "Approval access is required."
        : null;
  return (
    <>
      <Text accessibilityRole="header" className="p-4 text-lg font-semibold text-foreground">
        {order.title}
      </Text>
      {message ? (
        <Text accessibilityLiveRegion="polite" className="p-4 text-foreground">
          {message}
        </Text>
      ) : null}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh evidence"
        disabled={refreshReason !== null}
        onPress={() => void run()}
      />
      {refreshReason ? <Text className="p-4 text-foreground-muted">{refreshReason}</Text> : null}
      {approval ? (
        <ApprovalEvidence approval={approval} budget={order.workflow.task.budgetLimit.limitCents} />
      ) : (
        <Text className="p-4 text-foreground-muted">
          Evidence is unavailable until revalidation succeeds.
        </Text>
      )}
      <SettingsActionRow
        icon="checkmark"
        label="Approve"
        disabled={reason !== null}
        onPress={() => void run("approve")}
      />
      <SettingsActionRow
        icon="xmark"
        label="Reject"
        tone="danger"
        disabled={reason !== null}
        onPress={reject}
      />
      {reason ? <Text className="p-4 text-foreground-muted">{reason}</Text> : null}
    </>
  );
}
