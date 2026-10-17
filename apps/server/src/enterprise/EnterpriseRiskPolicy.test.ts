import { assert, describe, it } from "@effect/vitest";
import { classifyEnterpriseRisk, requiredEnterpriseApprovers } from "./EnterpriseRiskPolicy.ts";

describe("EnterpriseRiskPolicy", () => {
  it("keeps ordinary source and documentation changes at tier 1 with one approver", () => {
    const result = classifyEnterpriseRisk(["calc.py", "docs/guide.md", "src/app/view.tsx"]);
    assert.equal(result.tier, 1);
    assert.deepEqual(result.criticalChanges, []);
    assert.equal(requiredEnterpriseApprovers(result.tier), 1);
  });

  it("never auto-approves: an empty diff is still tier 1", () => {
    assert.equal(classifyEnterpriseRisk([]).tier, 1);
  });

  it.each([
    ["db/migrations/0001_init.sql", "migration"],
    [".github/workflows/release.yml", "production_deploy"],
    ["Dockerfile", "production_deploy"],
    ["package.json", "dependency_scripts"],
    ["services/api/requirements.txt", "dependency_scripts"],
    ["src/auth/session.ts", "auth"],
    ["src/billing/invoice.ts", "billing"],
    [".env.production", "secrets"],
    ["certs/server.pem", "secrets"],
    ["infra/terraform/main.tf", "infrastructure"],
    ["k8s/network-policy.yaml", "network_policy"],
    ["CODEOWNERS", "permissions"],
  ] as const)("requires two approvers for %s (%s)", (path, change) => {
    const result = classifyEnterpriseRisk(["README.md", path]);
    assert.equal(result.tier, 2);
    assert.include(result.criticalChanges, change);
    assert.isAbove(result.matchedRules.length, 0);
    assert.equal(requiredEnterpriseApprovers(result.tier), 2);
  });
});
