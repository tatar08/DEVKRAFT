import { assert, describe, it } from "@effect/vitest";
import { redactEnterpriseSecrets, enterpriseSecretKinds } from "./EnterpriseSecretPolicy.ts";

describe("enterprise secret policy", () => {
  it.each([
    ["provider_key", `sk-proj-${"a".repeat(30)}`],
    ["github_token", `ghp_${"b".repeat(40)}`],
    ["aws_access_key", `AKIA${"C".repeat(16)}`],
    ["private_key", "-----BEGIN PRIVATE KEY-----\nfixture-material\n-----END PRIVATE KEY-----"],
    ["credential_assignment", `API_KEY=${"d".repeat(24)}`],
  ])("redacts %s without emitting the original value", (kind, value) => {
    assert.include(enterpriseSecretKinds(value), kind);
    const redacted = redactEnterpriseSecrets(`context ${value} context`);
    assert.notInclude(redacted, value);
    assert.include(redacted, `[REDACTED:${kind}]`);
    assert.include(redacted, "context");
  });
  it("leaves ordinary issue content and code unchanged", () => {
    const text = "Fix regression. const passwordMinLength = 16;";
    assert.deepEqual(enterpriseSecretKinds(text), []);
    assert.equal(redactEnterpriseSecrets(text), text);
  });
});
