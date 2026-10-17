import { ENTERPRISE_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** The cockpit list is cheap and read-only, so it refreshes on a short interval. */
const WORK_ORDER_REFRESH_MS = 5_000;

/**
 * Atoms for the Enterprise cockpit and approvals (Phase 5), shared by web and mobile.
 *
 * - `workOrders` is a read-scoped query: it never re-runs a gate or dispatches work.
 * - Everything else is a guarded command (three scopes, checked client-side before the RPC
 *   and again by the server). `getApproval` is a command too because it re-runs the
 *   deterministic gate to revalidate; callers should invoke it on demand, never on a timer.
 * - Write actions are serialized per environment so an approval cannot race the merge it enables.
 */
export function createEnterpriseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const actionScheduler = createAtomCommandScheduler();
  const perEnvironment = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    workOrders: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:enterprise:work-orders",
      tag: ENTERPRISE_WS_METHODS.listWorkOrders,
      staleTimeMs: 2_000,
      refreshIntervalMs: WORK_ORDER_REFRESH_MS,
    }),
    getApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:enterprise:approval:get",
      tag: ENTERPRISE_WS_METHODS.getApproval,
    }),
    recordApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:enterprise:approval:record",
      tag: ENTERPRISE_WS_METHODS.recordApproval,
      scheduler: actionScheduler,
      concurrency: perEnvironment,
    }),
    mergeTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:enterprise:merge",
      tag: ENTERPRISE_WS_METHODS.mergeTask,
      scheduler: actionScheduler,
      concurrency: perEnvironment,
    }),
    checkMerge: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:enterprise:merge:check",
      tag: ENTERPRISE_WS_METHODS.checkMerge,
    }),
    publishPullRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:enterprise:publish",
      tag: ENTERPRISE_WS_METHODS.publishPullRequest,
      scheduler: actionScheduler,
      concurrency: perEnvironment,
    }),
    cancelWorkflow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:enterprise:cancel",
      tag: ENTERPRISE_WS_METHODS.cancelWorkflow,
      scheduler: actionScheduler,
      concurrency: perEnvironment,
    }),
  };
}

export type EnterpriseEnvironmentAtoms = ReturnType<typeof createEnterpriseEnvironmentAtoms>;
