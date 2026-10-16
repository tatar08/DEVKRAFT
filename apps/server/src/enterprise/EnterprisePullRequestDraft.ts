import type { PullRequestEvidence, TaskSpec } from "@t3tools/contracts";
import { redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";

// Data can contain Markdown or instructions. Render it as bounded, escaped data;
// the fixed review status comes from the server, never from agent prose.
const text = (value: string) =>
  redactEnterpriseSecrets(value)
    .replace(/[\r\n\u2028\u2029]/g, " ")
    .replace(/[\\`*_[\]<>|#]/g, "\\$&");

const renderCost = (evidence: PullRequestEvidence) =>
  evidence.cost.amountCents === null
    ? "Provider cost is unknown."
    : `Provider cost: $${(evidence.cost.amountCents / 100).toFixed(2)} (rounded up).`;

export function renderEnterprisePullRequestDraft(
  task: TaskSpec,
  evidence: PullRequestEvidence,
): string {
  const rows = [...evidence.tests, evidence.securityScan].map(
    (check) =>
      `| ${text(check.name)} | ${check.kind} | ${check.status} | ${check.artifactIds.map(text).join(", ")} |`,
  );
  return [
    "## Summary",
    "",
    `Task: ${text(task.taskId)}`,
    "",
    "Acceptance criteria:",
    "",
    ...task.acceptanceCriteria.map((criterion) => `- ${text(criterion)}`),
    "",
    "## Proof of work",
    "",
    `Checkpoint commit: \`${evidence.diffSha}\``,
    "",
    "| Check | Kind | Result | Evidence |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `V2 thread: ${text(evidence.provenance.threadId)}`,
    `V2 run: ${text(evidence.provenance.runId)}`,
    "",
    "## Review status",
    "",
    `Draft only. ${renderCost(evidence)} Authenticated approval, structured QA acceptance and publication have not been evaluated.`,
    "",
  ].join("\n");
}
