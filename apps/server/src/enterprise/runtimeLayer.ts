import * as Layer from "effect/Layer";
import type * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Approvals from "./EnterpriseApprovalService.ts";
import * as Issues from "./EnterpriseIssueService.ts";
import * as WorkOrders from "./EnterpriseWorkOrders.ts";
import * as MergeCheck from "./EnterpriseMergeCheck.ts";
import * as IssueWorkflows from "./EnterpriseIssueWorkflowService.ts";
import * as Pricing from "./EnterprisePricing.ts";
import * as Publication from "./EnterprisePublicationService.ts";
import * as Roles from "./EnterpriseRoleService.ts";
import * as RuntimePolicy from "./EnterpriseRuntimePolicy.ts";
import * as Tenancy from "./EnterpriseTenancy.ts";
import * as Automation from "./EnterpriseWorkflowAutomation.ts";
import * as Workflows from "./EnterpriseWorkflowService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

/** Role-thread runtime policy, provided into core's `RuntimePolicyRefinement` hook. */
export const layerRuntimePolicy = RuntimePolicy.layer.pipe(Layer.provide(ProcessRunner.layer));

/**
 * All Enterprise services plus the background automation worker, sharing one tenant allowlist. The composition root passes in
 * the core V2 layers Enterprise depends on, so wiring stays in this module.
 */
export const layer = <E1, R1, E2, R2>(deps: {
  readonly threadLaunch: Layer.Layer<Launch.ThreadLaunchService, E1, R1>;
  readonly threadManagement: Layer.Layer<Threads.ThreadManagementService, E2, R2>;
}) => {
  const layerRolesProvided = Roles.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Pricing.layer,
        deps.threadLaunch,
        deps.threadManagement,
        ProjectStore.layer,
        Workspace.layer,
        ProcessRunner.layer,
      ),
    ),
  );

  const layerWorkflowsProvided = Workflows.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Pricing.layer,
        layerRolesProvided,
        deps.threadManagement,
        ProjectStore.layer,
        Workspace.layer,
      ),
    ),
  );

  const layerAutomationProvided = Automation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerWorkflowsProvided,
        deps.threadManagement,
        Workspace.layer,
        AuthSessions.layer,
      ),
    ),
  );

  const layerPublicationProvided = Publication.layer.pipe(
    Layer.provide(Layer.mergeAll(layerWorkflowsProvided, Workspace.layer, ProcessRunner.layer)),
    Layer.provide(Git.layer),
  );

  const layerIssueWorkflowProvided = IssueWorkflows.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerAutomationProvided,
        Issues.layer.pipe(Layer.provide(ProcessRunner.layer)),
      ),
    ),
  );

  return Layer.mergeAll(
    layerIssueWorkflowProvided,
    layerPublicationProvided,
    layerAutomationProvided,
    Automation.layerWorker.pipe(Layer.provide(layerAutomationProvided)),
    layerWorkflowsProvided,
    layerRolesProvided,
    MergeCheck.layer.pipe(Layer.provide(layerRolesProvided)),
    WorkOrders.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerAutomationProvided,
          layerPublicationProvided,
          deps.threadManagement,
          Workspace.layer,
        ),
      ),
    ),
    Approvals.layer.pipe(
      Layer.provide(Layer.mergeAll(layerWorkflowsProvided, Workspace.layer, AuthSessions.layer)),
    ),
    // Merged into the output so ws.ts handlers check tenants with the same operator allowlist.
  ).pipe(Layer.provideMerge(Tenancy.layer));
};
