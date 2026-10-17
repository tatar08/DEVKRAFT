import { useState } from "react";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { enterpriseEnvironment } from "~/state/enterprise";
import { useEnvironmentQuery } from "~/state/query";
import { SidebarInset } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkOrderDetail } from "./WorkOrderDetail";
import { relativeUpdatedAt, workOrderColumns } from "./workOrders.logic";

/** Each environment owns its query, errors and actions, including remote connections. */
export function FounderCockpit() {
  const { environments, isReady } = useEnvironments();
  return (
    <SidebarInset>
      <WorkspacePageHeader>
        <h1>Founder Cockpit</h1>
      </WorkspacePageHeader>
      <div className="overflow-auto">
        <WorkspacePageContainer width="expanded">
          {!isReady ? (
            <p role="status">Loading environments…</p>
          ) : environments.length === 0 ? (
            <p>No environments configured.</p>
          ) : null}
          {environments.map((environment) => (
            <EnvironmentBoard key={environment.environmentId} environment={environment} />
          ))}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function EnvironmentBoard({ environment }: { environment: EnvironmentPresentation }) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    enterpriseEnvironment.workOrders({ environmentId: environment.environmentId, input: {} }),
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = query.data?.workOrders.find((order) => order.key === selectedKey);
  return (
    <section className="space-y-4" aria-label={environment.label}>
      <h2 className="text-lg font-medium">{environment.label}</h2>
      {!connected ? (
        <p role="status">
          Environment disconnected. Actions are unavailable; any stored results may be outdated.
        </p>
      ) : null}
      {query.error ? (
        <div role="alert">
          <p>Could not refresh work orders: {query.error}</p>
          <Button size="xl" variant="outline" disabled={!connected} onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {!query.data && connected && !query.error ? <p role="status">Loading work orders…</p> : null}
      {query.data?.workOrders.length === 0 ? <p>No work orders in this environment.</p> : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {workOrderColumns.map(([stage, label]) => (
          <section key={stage} className="min-w-0 rounded-lg border p-3">
            <h3 className="mb-3 font-medium">{label}</h3>
            <ul className="space-y-3">
              {query.data?.workOrders
                .filter((order) => order.stage === stage)
                .map((order) => (
                  <li key={order.key} className="rounded-md border bg-card p-3">
                    <button
                      type="button"
                      className="min-h-11 w-full rounded text-left focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setSelectedKey(order.key)}
                    >
                      <h4 className="font-medium">{order.title}</h4>
                      <p className="break-all text-xs text-muted-foreground">
                        {order.workflow.task.taskId}
                      </p>
                      {order.activeRole ? (
                        <p>
                          {order.activeRole.role} · revision {order.activeRole.revision}
                        </p>
                      ) : null}
                      <p className="text-sm">
                        Stored decisions: {order.approvals.approve} approve ·{" "}
                        {order.approvals.reject} reject
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {relativeUpdatedAt(order.updatedAt)}
                      </p>
                    </button>
                    {order.pullRequest ? (
                      <a
                        className="inline-flex min-h-11 items-center underline"
                        href={order.pullRequest.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PR #{order.pullRequest.number}
                      </a>
                    ) : null}
                  </li>
                ))}
            </ul>
            {!query.data?.workOrders.some((order) => order.stage === stage) ? (
              <p className="text-sm text-muted-foreground">No tasks</p>
            ) : null}
          </section>
        ))}
      </div>
      {selected ? (
        <WorkOrderDetail
          key={selected.key}
          order={selected}
          environmentId={environment.environmentId}
          connected={connected}
          onClose={() => setSelectedKey(null)}
          onChanged={query.refresh}
        />
      ) : null}
      {selectedKey && !selected ? (
        <p role="status">This work order is no longer available.</p>
      ) : null}
    </section>
  );
}
