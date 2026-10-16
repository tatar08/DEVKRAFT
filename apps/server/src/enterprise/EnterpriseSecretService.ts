import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import {
  ENTERPRISE_SECRET_GREP_PATTERNS,
  enterpriseSecretKinds,
} from "./EnterpriseSecretPolicy.ts";

export class EnterpriseSecretsDetected extends Schema.TaggedError<EnterpriseSecretsDetected>()(
  "EnterpriseSecretsDetected",
  {
    categories: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Enterprise secret guard blocked input: ${this.categories.join(", ")}.`;
  }
}
export class EnterpriseSecretScanError extends Schema.TaggedError<EnterpriseSecretScanError>()(
  "EnterpriseSecretScanError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Enterprise secret scan could not verify the input.";
  }
}
export class EnterpriseSecretService extends Context.Service<
  EnterpriseSecretService,
  {
    readonly assertCommitClean: (input: {
      readonly repositoryRoot: string;
      readonly commitSha: string;
    }) => Effect.Effect<void, EnterpriseSecretsDetected | EnterpriseSecretScanError>;
  }
>()("t3/enterprise/EnterpriseSecretService") {}
const make = Effect.gen(function* () {
  const git = yield* Git.GitVcsDriver;
  const assertCommitClean = Effect.fn("EnterpriseSecretService.assertCommitClean")(
    function* (input: { readonly repositoryRoot: string; readonly commitSha: string }) {
      const output = yield* git.execute({
        operation: "EnterpriseSecretService.scan",
        cwd: input.repositoryRoot,
        args: [
          "grep",
          "-I",
          "-n",
          "--no-textconv",
          "-i",
          "-E",
          ...ENTERPRISE_SECRET_GREP_PATTERNS.flatMap((pattern) => ["-e", pattern]),
          input.commitSha,
          "--",
        ],
        allowNonZeroExit: true,
        maxOutputBytes: 1_048_576,
      });
      if (output.exitCode === 1) return;
      if (output.exitCode !== 0)
        return yield* new EnterpriseSecretScanError({ cause: output.exitCode });
      const categories = [...enterpriseSecretKinds(output.stdout)];
      // Private-key markers may span lines not included by grep's candidate selection.
      if (output.stdout.includes("PRIVATE KEY-----")) categories.push("private_key");
      if (categories.length)
        return yield* new EnterpriseSecretsDetected({ categories: [...new Set(categories)] });
    },
  );
  return EnterpriseSecretService.of({
    assertCommitClean: (input) =>
      assertCommitClean(input).pipe(
        Effect.mapError((cause) =>
          cause._tag === "EnterpriseSecretsDetected" || cause._tag === "EnterpriseSecretScanError"
            ? cause
            : new EnterpriseSecretScanError({ cause }),
        ),
      ),
  });
});
export const layer = Layer.effect(EnterpriseSecretService, make);
