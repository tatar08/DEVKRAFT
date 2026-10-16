/** These recognizers are deliberately bounded rules, not a claim to detect every secret. */
const rules = [
  {
    kind: "private_key",
    source:
      "-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----",
  },
  { kind: "provider_key", source: "\\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\\b" },
  {
    kind: "github_token",
    source: "\\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\\b",
  },
  { kind: "aws_access_key", source: "\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b" },
  {
    kind: "credential_assignment",
    source:
      "(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|CLIENT_SECRET|PASSWORD)\\s*[:=]\\s*[\"']?[A-Za-z0-9+/._=-]{16,}",
  },
] as const;

export function redactEnterpriseSecrets(text: string): string {
  let result = text;
  for (const rule of rules)
    result = result.replace(new RegExp(rule.source, "gi"), `[REDACTED:${rule.kind}]`);
  return result;
}

export function enterpriseSecretKinds(text: string): ReadonlyArray<string> {
  return rules.filter((rule) => new RegExp(rule.source, "i").test(text)).map((rule) => rule.kind);
}

/** Git's ERE engine is used only to select candidate lines; JS recognizes complete keys. */
export const ENTERPRISE_SECRET_GREP_PATTERNS = [
  "-----BEGIN .*PRIVATE KEY-----",
  "sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}",
  "gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}",
  "(AKIA|ASIA)[A-Z0-9]{16}",
  "(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|CLIENT_SECRET|PASSWORD)[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9+/._=-]{16,}",
] as const;
