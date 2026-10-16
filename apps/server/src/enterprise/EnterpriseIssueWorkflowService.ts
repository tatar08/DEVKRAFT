import {
  AuthSessionId,
  EnterpriseRoleError,
  EnterpriseStartIssueWorkflowInput,
  type EnterpriseStartWorkflowResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Issues from "./EnterpriseIssueService.ts";
import * as Automation from "./EnterpriseWorkflowAutomation.ts";
const decodeInput = Schema.decodeUnknownEffect(EnterpriseStartIssueWorkflowInput);

export class EnterpriseIssueWorkflowService extends Context.Service<
  EnterpriseIssueWorkflowService,
  {
    readonly start: (
      input: EnterpriseStartIssueWorkflowInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<EnterpriseStartWorkflowResult, EnterpriseRoleError>;
  }
>()("t3/enterprise/EnterpriseIssueWorkflowService") {}
const make = Effect.gen(function* () {
  const issues = yield* Issues.EnterpriseIssueService;
  const automation = yield* Automation.EnterpriseWorkflowAutomation;
  const start = Effect.fn("EnterpriseIssueWorkflowService.start")(function* (
    raw: EnterpriseStartIssueWorkflowInput,
    sessionId: AuthSessionId,
  ) {
    // No external fetch or agent launch before verifying the authenticated actor.
    yield* automation.authorize(sessionId);
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError((cause) => new EnterpriseRoleError({ reason: "invalid_input", cause })),
    );
    const issueContext = yield* issues
      .loadContext(input.issueUrl)
      .pipe(
        Effect.mapError((cause) => new EnterpriseRoleError({ reason: "invalid_input", cause })),
      );
    if (new TextEncoder().encode(issueContext).length > 65_536)
      return yield* new EnterpriseRoleError({ reason: "context_too_large" });
    // Grants, model routing, repository and budget remain operator-owned configuration.
    // start revalidates the session after the fetch and persists the frozen issue snapshot.
    return yield* automation.start({ ...input.workflow, issueContext }, sessionId);
  });
  return EnterpriseIssueWorkflowService.of({ start });
});
export const layer = Layer.effect(EnterpriseIssueWorkflowService, make);
