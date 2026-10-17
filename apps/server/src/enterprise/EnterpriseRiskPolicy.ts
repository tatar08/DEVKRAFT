import type { RiskDecision } from "@t3tools/contracts";

type CriticalChange = RiskDecision["criticalChanges"][number];

interface RiskRule {
  /** Stable identifier recorded in `RiskDecision.matchedRules` for audit. */
  readonly id: string;
  readonly change: CriticalChange;
  readonly path: RegExp;
}

/**
 * Path rules for changes the Blueprint forbids auto-approving. They are deliberately broad: a false
 * positive costs a second reviewer, a false negative lets a critical change through with one.
 * Matching uses repository-relative paths from the server's own diff, never agent-reported paths.
 */
const RULES: ReadonlyArray<RiskRule> = [
  { id: "migration.path", change: "migration", path: /(?:^|\/)migrations?\//i },
  { id: "migration.sql", change: "migration", path: /\.sql$/i },
  {
    id: "deploy.ci",
    change: "production_deploy",
    path: /^(?:\.github\/workflows|\.gitlab-ci\.yml$|\.circleci\/)/i,
  },
  {
    id: "deploy.container",
    change: "production_deploy",
    path: /(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*|Procfile)$/i,
  },
  { id: "deploy.path", change: "production_deploy", path: /(?:^|\/)deploy(?:ment)?s?\//i },
  { id: "permissions.path", change: "permissions", path: /(?:^|\/)(?:permissions?|rbac|acl)/i },
  { id: "permissions.codeowners", change: "permissions", path: /(?:^|\/)CODEOWNERS$/ },
  {
    id: "dependency.manifest",
    change: "dependency_scripts",
    path: /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|\.npmrc|setup\.py|setup\.cfg|pyproject\.toml|requirements[^/]*\.txt|Pipfile|Gemfile|Cargo\.toml|go\.mod|build\.gradle(?:\.kts)?|pom\.xml|Makefile)$/i,
  },
  {
    id: "dependency.lockfile",
    change: "dependency_scripts",
    path: /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|Cargo\.lock|go\.sum)$/i,
  },
  { id: "auth.path", change: "auth", path: /(?:^|\/)(?:auth|authn|authz|oauth|login|session)/i },
  {
    id: "billing.path",
    change: "billing",
    path: /(?:^|\/)(?:billing|payments?|invoices?|stripe)/i,
  },
  {
    id: "secrets.path",
    change: "secrets",
    path: /(?:^|\/)(?:\.env(?:\.|$)|secrets?[/.]|credentials?|[^/]*\.(?:pem|key|p12|pfx)$)/i,
  },
  {
    id: "infrastructure.path",
    change: "infrastructure",
    path: /(?:^|\/)(?:terraform|infra(?:structure)?|k8s|kubernetes|helm|ansible|pulumi)\//i,
  },
  { id: "infrastructure.tf", change: "infrastructure", path: /\.(?:tf|tfvars|hcl)$/i },
  {
    id: "network.policy",
    change: "network_policy",
    path: /(?:^|\/)(?:network-?polic(?:y|ies)|firewall|ingress|egress)/i,
  },
];

export interface EnterpriseRiskClassification {
  readonly tier: 1 | 2;
  readonly criticalChanges: ReadonlyArray<CriticalChange>;
  readonly matchedRules: ReadonlyArray<string>;
}

/**
 * Tier 2 (two distinct approvers) for any critical change, otherwise tier 1 (one approver).
 * Tier 0 is never produced: the MVP has no auto-approval. An empty diff is still tier 1.
 */
export const classifyEnterpriseRisk = (
  changedPaths: ReadonlyArray<string>,
): EnterpriseRiskClassification => {
  const matched = RULES.filter((rule) => changedPaths.some((path) => rule.path.test(path)));
  const criticalChanges = [...new Set(matched.map((rule) => rule.change))].toSorted();
  return {
    tier: criticalChanges.length > 0 ? 2 : 1,
    criticalChanges,
    matchedRules: matched.map((rule) => rule.id).toSorted(),
  };
};

/** Distinct authenticated approvers a tier needs before a merge may proceed. */
export const requiredEnterpriseApprovers = (tier: 1 | 2): 1 | 2 => (tier === 2 ? 2 : 1);
