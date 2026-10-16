import {
  EnterpriseApprovalBlocker,
  PullRequestEvidence,
  RiskDecision,
  TaskSpec,
  getEnterpriseApprovalBlockers,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const EvidenceBundle = Schema.Struct({
  task: TaskSpec,
  evidence: PullRequestEvidence,
  risk: RiskDecision,
});
const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(EvidenceBundle));
const MAX_BUNDLE_BYTES = 1_048_576;

export class EnterpriseEvidenceReadError extends Schema.TaggedError<EnterpriseEvidenceReadError>()(
  "EnterpriseEvidenceReadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the enterprise evidence bundle.`;
  }
}

export class EnterpriseEvidenceTooLarge extends Schema.TaggedError<EnterpriseEvidenceTooLarge>()(
  "EnterpriseEvidenceTooLarge",
  {},
) {
  override get message(): string {
    return "The enterprise evidence bundle exceeds 1 MiB.";
  }
}

export class EnterpriseEvidenceBlocked extends Schema.TaggedError<EnterpriseEvidenceBlocked>()(
  "EnterpriseEvidenceBlocked",
  {
    blockers: Schema.Array(EnterpriseApprovalBlocker),
  },
) {
  override get message(): string {
    return `Enterprise evidence checks blocked: ${this.blockers.join(", ")}.`;
  }
}

export class EnterpriseEvidenceService extends Context.Service<
  EnterpriseEvidenceService,
  {
    readonly verifyFile: (input: {
      readonly bundlePath: string;
      readonly currentCommitSha: string;
      readonly currentPolicyVersion: string;
    }) => Effect.Effect<
      TaskSpec,
      EnterpriseEvidenceReadError | EnterpriseEvidenceTooLarge | EnterpriseEvidenceBlocked
    >;
  }
>()("t3/enterprise/EnterpriseEvidenceService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const verifyFile = Effect.fn("EnterpriseEvidenceService.verifyFile")(function* (input: {
    readonly bundlePath: string;
    readonly currentCommitSha: string;
    readonly currentPolicyVersion: string;
  }) {
    const info = yield* fs
      .stat(input.bundlePath)
      .pipe(
        Effect.mapError((cause) => new EnterpriseEvidenceReadError({ operation: "read", cause })),
      );
    if (info.size > MAX_BUNDLE_BYTES) return yield* new EnterpriseEvidenceTooLarge({});
    const content = yield* fs
      .readFileString(input.bundlePath)
      .pipe(
        Effect.mapError((cause) => new EnterpriseEvidenceReadError({ operation: "read", cause })),
      );
    if (new TextEncoder().encode(content).length > MAX_BUNDLE_BYTES)
      return yield* new EnterpriseEvidenceTooLarge({});
    const bundle = yield* decodeBundle(content).pipe(
      Effect.mapError((cause) => new EnterpriseEvidenceReadError({ operation: "decode", cause })),
    );
    const now = yield* DateTime.now;
    const blockers = getEnterpriseApprovalBlockers({
      ...bundle,
      currentCommitSha: input.currentCommitSha,
      currentPolicyVersion: input.currentPolicyVersion,
      nowEpochMillis: DateTime.toEpochMillis(now),
    });
    if (blockers.length > 0) return yield* new EnterpriseEvidenceBlocked({ blockers });
    return bundle.task;
  });
  return EnterpriseEvidenceService.of({ verifyFile });
});

export const layer = Layer.effect(EnterpriseEvidenceService, make);
