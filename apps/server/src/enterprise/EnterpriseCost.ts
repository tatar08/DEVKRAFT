/**
 * Cost accounting and the per-task circuit breaker. Pure functions: callers own persistence and
 * the clock, and feed provider-reported token usage from V2 into them.
 *
 * Amounts are USD cents. Unknown cost is `null` and never an invented zero; a model priced at
 * zero (for example a local Ollama model) is a deliberate, known price.
 */

/** Default per-task ceiling: $1.50. TaskSpec.budgetLimit overrides it. */
export const DEFAULT_TASK_BUDGET_CENTS = 150;
const BASIS_POINTS = 10_000;

export interface ModelPrice {
  /** Cents per one million tokens; fractional values are allowed. */
  readonly inputCentsPerMillion: number;
  readonly outputCentsPerMillion: number;
  /** Falls back to the input price when the provider has no cache discount. */
  readonly cachedInputCentsPerMillion?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Subset of `inputTokens` served from the provider cache. */
  readonly cachedInputTokens?: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

const isCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

/**
 * Provider cost for one usage record, rounded up so rounding can never hide spend.
 * Returns `null` for an unpriced model or malformed usage.
 */
export function priceUsage(usage: TokenUsage, price: ModelPrice | undefined): number | null {
  if (price === undefined) return null;
  const cached = usage.cachedInputTokens ?? 0;
  if (!isCount(usage.inputTokens) || !isCount(usage.outputTokens) || !isCount(cached)) return null;
  if (cached > usage.inputTokens) return null;
  const rates = [price.inputCentsPerMillion, price.outputCentsPerMillion];
  if (price.cachedInputCentsPerMillion !== undefined) rates.push(price.cachedInputCentsPerMillion);
  if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) return null;
  const cachedRate = price.cachedInputCentsPerMillion ?? price.inputCentsPerMillion;
  const cents =
    ((usage.inputTokens - cached) * price.inputCentsPerMillion +
      cached * cachedRate +
      usage.outputTokens * price.outputCentsPerMillion) /
    1_000_000;
  const rounded = Math.ceil(cents);
  return isCount(rounded) ? rounded : null;
}

/** Applies a per-project markup in basis points (2500 = +25%); rounds up. */
export function applyMarkup(providerCents: number, markupBps: number): number | null {
  if (!Number.isSafeInteger(providerCents) || providerCents < 0) return null;
  if (!Number.isSafeInteger(markupBps) || markupBps < 0) return null;
  // Integer arithmetic preserves cents even when the intermediate product is unsafe.
  const divisor = BigInt(BASIS_POINTS);
  const billed = (BigInt(providerCents) * (divisor + BigInt(markupBps)) + divisor - 1n) / divisor;
  return billed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(billed) : null;
}

export interface UsageRecord {
  readonly model: string;
  readonly usage: TokenUsage;
}

export interface TaskCostState {
  readonly providerCents: number;
  /** Records whose cost could not be determined; the breaker fails closed on these. */
  readonly unpricedRecords: number;
}

export const emptyTaskCost: TaskCostState = { providerCents: 0, unpricedRecords: 0 };

export function recordUsage(
  state: TaskCostState,
  record: UsageRecord,
  prices: PriceTable,
): TaskCostState {
  const cents = priceUsage(record.usage, prices[record.model]);
  const total = cents === null ? null : state.providerCents + cents;
  return total === null || !isCount(total) || !isCount(state.providerCents)
    ? { ...state, unpricedRecords: state.unpricedRecords + 1 }
    : { ...state, providerCents: total };
}

export interface ProjectBilling {
  readonly projectId: string;
  readonly providerCents: number;
  readonly billedCents: number;
  readonly unpricedRecords: number;
}

/** Aggregates per-task cost into per-project billed totals with the project's markup. */
export function billProject(input: {
  readonly projectId: string;
  readonly markupBps: number;
  readonly tasks: ReadonlyArray<TaskCostState>;
}): ProjectBilling | null {
  if (input.tasks.some((task) => !isCount(task.providerCents) || !isCount(task.unpricedRecords)))
    return null;
  const providerCents = input.tasks.reduce((sum, task) => sum + task.providerCents, 0);
  const unpricedRecords = input.tasks.reduce((sum, task) => sum + task.unpricedRecords, 0);
  if (!isCount(unpricedRecords)) return null;
  const billedCents = applyMarkup(providerCents, input.markupBps);
  if (billedCents === null) return null;
  return {
    projectId: input.projectId,
    providerCents,
    billedCents,
    unpricedRecords,
  };
}

export type BudgetDecision =
  | { readonly status: "ok"; readonly remainingCents: number }
  | { readonly status: "tripped"; readonly reason: "budget_exceeded" | "cost_unknown" };

/**
 * Per-task circuit breaker. Trips when spend exceeds the limit or when any usage is unpriced
 * (fail closed: a loop on an unpriced model must not run unbounded). `nextCallEstimateCents`
 * lets callers refuse a call that would cross the limit before making it.
 */
export function evaluateBudget(input: {
  readonly state: TaskCostState;
  readonly limitCents: number;
  readonly nextCallEstimateCents?: number;
}): BudgetDecision {
  if (!Number.isSafeInteger(input.limitCents) || input.limitCents < 1)
    return { status: "tripped", reason: "budget_exceeded" };
  const estimate = input.nextCallEstimateCents ?? 0;
  if (
    !isCount(input.state.providerCents) ||
    !isCount(input.state.unpricedRecords) ||
    input.state.unpricedRecords > 0 ||
    !isCount(estimate)
  )
    return { status: "tripped", reason: "cost_unknown" };
  // Compare against the remainder to avoid overflowing when adding the estimate.
  return estimate > input.limitCents - input.state.providerCents
    ? { status: "tripped", reason: "budget_exceeded" }
    : { status: "ok", remainingCents: input.limitCents - input.state.providerCents };
}
