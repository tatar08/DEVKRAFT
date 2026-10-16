import { EnterpriseAdvanceWorkflowInput, TaskSpec } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(EnterpriseAdvanceWorkflowInput));
export const normalizeEnterpriseWorkflow = (input: EnterpriseAdvanceWorkflowInput) => ({
  ...input,
  issueContext: redactEnterpriseSecrets(input.issueContext),
});
export const enterpriseWorkflowKey = Effect.fn("enterpriseWorkflowKey")(function* (
  input: EnterpriseAdvanceWorkflowInput,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(yield* encode(normalizeEnterpriseWorkflow(input))),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

const encodeIdentity = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      tenantId: TaskSpec.fields.tenantId,
      projectId: TaskSpec.fields.projectId,
      taskId: TaskSpec.fields.taskId,
    }),
  ),
);
export const enterpriseTaskKey = Effect.fn("enterpriseTaskKey")(function* (task: TaskSpec) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(yield* encodeIdentity(task)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});
