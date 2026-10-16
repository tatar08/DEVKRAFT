import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { makeEnterpriseCodexProbe } from "./EnterpriseCodexSupport.ts";
import { isEnterpriseCoderThreadId, isEnterpriseRoleThreadId } from "./EnterpriseRun.ts";

/**
 * Pins Enterprise role threads to the named deny-by-default Codex profile on every resolve, even
 * if the thread requests full access or switches provider. Non-role threads pass through.
 */
export const layer = Layer.effect(
  RuntimePolicy.RuntimePolicyRefinement,
  Effect.gen(function* () {
    const codex = yield* makeEnterpriseCodexProbe;
    return RuntimePolicy.RuntimePolicyRefinement.of({
      refine: Effect.fn("EnterpriseRuntimePolicy.refine")(function* (input) {
        if (!isEnterpriseRoleThreadId(input.thread.id)) return input.policy;
        const reject = (cause: unknown) =>
          new RuntimePolicy.RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
            cause,
          });
        if (input.thread.worktreePath === null) return yield* reject("missing_worktree");
        const installation = yield* codex
          .check({ instanceId: input.modelSelection.instanceId, driverKind: input.driverKind })
          .pipe(Effect.mapError(reject));
        return {
          ...input.policy,
          disableT3Mcp: true,
          approvalPolicy: "never",
          filesystemAccess: isEnterpriseCoderThreadId(input.thread.id) ? "write" : "read",
          readonlyToolchainRoots: [installation.toolchainRoot],
          disabledMcpServerNames: [...new Set(["t3-code", ...installation.mcpServerNames])],
        };
      }),
    });
  }),
);
