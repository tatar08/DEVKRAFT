import type { EnterpriseApprovalStatus } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { blockerMessage, ignoredMessage } from "./approvals.logic";

/** Compact proof of work retains every gate input needed for a human decision. */
export function ApprovalEvidence({
  approval,
  budget,
}: {
  approval: EnterpriseApprovalStatus;
  budget: number;
}) {
  const { evidence, risk, requiredApprovers, ignored, blockers } = approval;
  return (
    <View className="gap-3 p-4">
      <Text accessibilityRole="header" className="text-lg font-semibold text-foreground">
        Proof of Work
      </Text>
      <Text selectable className="text-foreground">
        Commit: {evidence.diffSha}
      </Text>
      {[...evidence.tests, evidence.securityScan].map((check) => (
        <Text key={`${check.kind}:${check.name}:${check.commitSha}`} className="text-foreground">
          {check.name} ({check.kind}): {check.status.replaceAll("_", " ")}
        </Text>
      ))}
      <Text className="text-foreground">
        Cost:{" "}
        {evidence.cost.amountCents === null
          ? "unknown"
          : `$${(evidence.cost.amountCents / 100).toFixed(2)}`}{" "}
        / ${(budget / 100).toFixed(2)} budget
      </Text>
      <Text className="text-foreground">
        Risk tier: {risk.tier} · {risk.decision}
      </Text>
      <Text className="text-foreground">
        Critical changes: {risk.criticalChanges.join(", ") || "None"}
      </Text>
      <Text className="text-foreground">
        Matched rules: {risk.matchedRules.join(", ") || "None"}
      </Text>
      <Text className="text-foreground">
        Counted approvers: {risk.approvers.length} / {requiredApprovers} required
      </Text>
      <Text accessibilityRole="header" className="font-semibold text-foreground">
        Ignored decisions
      </Text>
      {ignored.length ? (
        ignored.map((entry) => (
          <Text key={`${entry.sessionId}:${entry.reason}`} className="text-foreground">
            {entry.sessionId}: {ignoredMessage[entry.reason]}
          </Text>
        ))
      ) : (
        <Text className="text-foreground">None</Text>
      )}
      <Text accessibilityRole="header" className="font-semibold text-foreground">
        Blockers
      </Text>
      {blockers.length ? (
        blockers.map((blocker) => (
          <Text key={blocker} className="text-foreground">
            {blockerMessage[blocker]}
          </Text>
        ))
      ) : (
        <Text className="text-foreground">No approval blockers.</Text>
      )}
    </View>
  );
}
