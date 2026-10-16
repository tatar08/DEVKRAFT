import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  emptyTaskCost,
  evaluateBudget,
  recordUsage,
  type BudgetDecision,
  type PriceTable,
  type TaskCostState,
} from "./EnterpriseCost.ts";

type CostProjection = Pick<OrchestrationV2ThreadProjection, "thread" | "providerTurns"> &
  Partial<Pick<OrchestrationV2ThreadProjection, "runs" | "attempts">>;

/**
 * Sums provider-reported usage over a task's role threads. Only finished turns count: usage
 * is reported when a turn ends, so one long turn can overrun the budget before it is seen.
 * A started turn without complete usage is unpriced, which the breaker treats as unknown.
 */
export function taskCostFromProjections(
  projections: ReadonlyArray<CostProjection>,
  prices: PriceTable,
): TaskCostState {
  let state = emptyTaskCost;
  for (const projection of projections) {
    for (const turn of projection.providerTurns) {
      if (turn.status === "pending" || turn.status === "running") continue;
      const usage = turn.turnTokenUsage;
      if (usage === undefined || usage.usageStatus !== "complete") {
        // A turn that never started consumed nothing.
        if (turn.startedAt !== null)
          state = {
            providerCents: state.providerCents,
            unpricedRecords: state.unpricedRecords + 1,
          };
        continue;
      }
      // A retry can use a different model. Attribute each turn to its immutable run,
      // rather than retroactively charging every turn at the thread's current selection.
      const attempt = projection.attempts?.find((attempt) => attempt.id === turn.runAttemptId);
      const run =
        attempt === undefined
          ? undefined
          : projection.runs?.find((run) => run.id === attempt.runId);
      if (projection.attempts !== undefined && run === undefined) {
        state = { providerCents: state.providerCents, unpricedRecords: state.unpricedRecords + 1 };
        continue;
      }
      const model = run?.modelSelection.model ?? projection.thread.modelSelection.model;
      state = recordUsage(
        state,
        {
          model,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: usage.cachedInputTokens }),
          },
        },
        prices,
      );
    }
  }
  return state;
}

export function evaluateTaskBudget(input: {
  readonly projections: ReadonlyArray<CostProjection>;
  readonly prices: PriceTable;
  readonly limitCents: number;
}): { readonly cost: TaskCostState; readonly decision: BudgetDecision } {
  const cost = taskCostFromProjections(input.projections, input.prices);
  return { cost, decision: evaluateBudget({ state: cost, limitCents: input.limitCents }) };
}
