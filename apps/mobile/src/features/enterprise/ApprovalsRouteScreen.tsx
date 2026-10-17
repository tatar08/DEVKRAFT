import { useNavigation } from "@react-navigation/native";
import type { EnterpriseWorkOrder, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ListRow } from "../../components/ListRow";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { enterpriseEnvironment } from "../../state/enterprise";
import { useEnvironmentQuery } from "../../state/query";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsRouteScreen } from "../settings/SettingsRouteScreen";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ApprovalDetail } from "./ApprovalDetail";
import { awaitingApproval } from "./approvals.logic";

// Session-only cache: disconnecting or reopening the inbox preserves the last read,
// without persisting potentially sensitive evidence or queueing decisions on disk.
const cachedOrders = new Map<EnvironmentId, readonly EnterpriseWorkOrder[]>();

/** A Settings entry keeps this MVP reachable without changing workspace navigation. */
export function SettingsWithApprovals() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-sheet">
      <SettingsRouteScreen />
      <View style={{ paddingBottom: insets.bottom }}>
        <ListRow
          icon="checkmark"
          label="Approvals"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsApprovals" },
            })
          }
        />
      </View>
    </View>
  );
}

/** Each saved environment retains an independent read-only inbox when offline. */
export function ApprovalsRouteScreen() {
  const environments = useWorkspaceEnvironments();
  const ready = useConnectionsReady();
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Approvals">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!ready ? (
          <Text className="text-foreground">Loading environments…</Text>
        ) : environments.length === 0 ? (
          <Text className="text-foreground">No environments configured.</Text>
        ) : null}
        {environments.map((environment) => (
          <EnvironmentInbox key={environment.environmentId} environment={environment} />
        ))}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentInbox({ environment }: { environment: ConnectedEnvironmentSummary }) {
  const { environmentId } = environment;
  const connected = environment.isEnabled && environment.connectionState === "connected";
  const query = useEnvironmentQuery(enterpriseEnvironment.workOrders({ environmentId, input: {} }));
  useEffect(() => {
    if (query.data) cachedOrders.set(environmentId, query.data.workOrders);
  }, [environmentId, query.data]);
  const orders = query.data?.workOrders ?? cachedOrders.get(environmentId);
  const [selected, setSelected] = useState<string | null>(null);
  const order = orders?.find((candidate) => candidate.key === selected);
  return (
    <SettingsSection title={environment.environmentLabel}>
      {!connected ? (
        <Text className="p-4 text-foreground-muted">
          Disconnected. Cached work orders are read-only and may be outdated.
        </Text>
      ) : null}
      {query.error ? (
        <Text className="p-4 text-foreground">Could not refresh work orders: {query.error}</Text>
      ) : null}
      {!orders ? (
        <Text className="p-4 text-foreground">
          {connected && !query.error ? "Loading work orders…" : "No cached work orders available."}
        </Text>
      ) : null}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh list"
        disabled={!connected}
        onPress={query.refresh}
      />
      {orders && awaitingApproval(orders).length === 0 ? (
        <Text className="p-4 text-foreground">No work orders awaiting approval.</Text>
      ) : null}
      {orders &&
        awaitingApproval(orders).map((item) => (
          <ListRow
            key={item.key}
            icon="checkmark"
            label={item.title}
            description={`${item.workflow.task.taskId} · ${item.approvals.approve} approve · ${item.approvals.reject} reject`}
            onPress={() => setSelected(item.key)}
          />
        ))}
      {selected ? (
        <SettingsActionRow icon="xmark" label="Close detail" onPress={() => setSelected(null)} />
      ) : null}
      {order ? (
        <ApprovalDetail
          key={order.key}
          order={order}
          environmentId={environmentId}
          connected={connected}
          onChanged={query.refresh}
        />
      ) : selected ? (
        <Text className="p-4 text-foreground">This work order is no longer available.</Text>
      ) : null}
    </SettingsSection>
  );
}
