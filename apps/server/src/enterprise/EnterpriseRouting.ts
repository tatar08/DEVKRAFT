/**
 * Hybrid routing policy: which tier runs a unit of work, and which model replaces one that is
 * rate limited. Pure functions with an explicit clock; callers persist the cooldown state.
 *
 * The decision itself is an in-memory computation. End-to-end failover latency depends on the
 * provider and is intentionally not promised here.
 */

export type RoutingTier = "local" | "cloud";

export type EnterpriseWorkKind =
  | "architecture"
  | "implementation"
  | "review"
  | "test_run"
  | "lint_fix"
  | "typecheck_fix"
  | "docs";

export type RoutingReason =
  | "kind_prefers_local"
  | "kind_requires_cloud"
  | "critical_change"
  | "local_unavailable";

const LOCAL_KINDS: ReadonlySet<EnterpriseWorkKind> = new Set([
  "test_run",
  "lint_fix",
  "typecheck_fix",
  "docs",
]);

/**
 * Mechanical, easily verified work goes to the local GPU; design and judgement stay on cloud
 * models. Any critical change (auth, billing, migrations, ...) is never routed local.
 */
export function routeWork(input: {
  readonly kind: EnterpriseWorkKind;
  readonly criticalChanges: ReadonlyArray<string>;
  readonly localAvailable: boolean;
}): { readonly tier: RoutingTier; readonly reason: RoutingReason } {
  if (input.criticalChanges.length > 0) return { tier: "cloud", reason: "critical_change" };
  if (!LOCAL_KINDS.has(input.kind)) return { tier: "cloud", reason: "kind_requires_cloud" };
  return input.localAvailable
    ? { tier: "local", reason: "kind_prefers_local" }
    : { tier: "cloud", reason: "local_unavailable" };
}

export interface ModelCandidate {
  readonly instanceId: string;
  readonly model: string;
  readonly tier: RoutingTier;
}

/** Epoch milliseconds until which a model must not be used, keyed by `instanceId/model`. */
export type CooldownState = Readonly<Record<string, number>>;

export const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
/** Rate limited, overloaded, or temporarily unavailable. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503, 529]);

export const candidateKey = (candidate: ModelCandidate): string =>
  `${candidate.instanceId}/${candidate.model}`;

/** Marks `failed` as cooling down when the error is a retryable provider limit. */
export function recordProviderFailure(input: {
  readonly cooldowns: CooldownState;
  readonly failed: ModelCandidate;
  readonly status: number | undefined;
  readonly retryAfterMs?: number;
  readonly nowEpochMillis: number;
}): CooldownState {
  if (input.status === undefined || !RETRYABLE_STATUSES.has(input.status)) return input.cooldowns;
  const requested =
    input.retryAfterMs !== undefined &&
    Number.isFinite(input.retryAfterMs) &&
    input.retryAfterMs > 0
      ? input.retryAfterMs
      : DEFAULT_COOLDOWN_MS;
  return {
    ...input.cooldowns,
    [candidateKey(input.failed)]: input.nowEpochMillis + Math.min(requested, MAX_COOLDOWN_MS),
  };
}

export type ModelSelection =
  | {
      readonly status: "selected";
      readonly candidate: ModelCandidate;
      readonly failedOver: boolean;
    }
  | { readonly status: "unavailable"; readonly retryAtEpochMillis: number | null };

/**
 * Picks the first candidate of the required tier that is not cooling down. Work that must stay
 * local never silently falls back to cloud; cloud fallback is an explicit opt-in because it sends
 * repository content to a third party.
 */
export function selectModel(input: {
  readonly tier: RoutingTier;
  readonly candidates: ReadonlyArray<ModelCandidate>;
  readonly cooldowns: CooldownState;
  readonly nowEpochMillis: number;
  readonly allowCloudFallback: boolean;
}): ModelSelection {
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.tier === input.tier || (input.tier === "local" && input.allowCloudFallback),
  );
  const ordered = [
    ...eligible.filter((candidate) => candidate.tier === input.tier),
    ...eligible.filter((candidate) => candidate.tier !== input.tier),
  ];
  const ready = ordered.find(
    (candidate) => (input.cooldowns[candidateKey(candidate)] ?? 0) <= input.nowEpochMillis,
  );
  if (ready !== undefined) {
    return { status: "selected", candidate: ready, failedOver: ready !== ordered[0] };
  }
  const waits = ordered
    .map((candidate) => input.cooldowns[candidateKey(candidate)])
    .filter((until): until is number => until !== undefined);
  return {
    status: "unavailable",
    retryAtEpochMillis: waits.length === 0 ? null : Math.min(...waits),
  };
}
