import { EnterpriseGithubIssueUrl, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { redactEnterpriseSecrets } from "./EnterpriseSecretPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";

const IssueUrl = EnterpriseGithubIssueUrl;
const Issue = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
  body: Schema.String.check(Schema.isMaxLength(262144)),
  url: IssueUrl,
});
const decodeUrl = Schema.decodeUnknownEffect(IssueUrl);
const decodeIssue = Schema.decodeUnknownEffect(Schema.fromJsonString(Issue));
const encodeArtifact = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      source: Schema.Literal("github_issue"),
      trust: Schema.Literal("untrusted_content"),
      issue: Issue,
    }),
  ),
);
export class EnterpriseIssueError extends Schema.TaggedError<EnterpriseIssueError>()(
  "EnterpriseIssueError",
  {
    stage: Schema.Literals(["validate", "fetch", "decode", "write"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Enterprise issue import failed at ${this.stage}. GitHub CLI must be installed and authenticated for fetching.`;
  }
}
export class EnterpriseIssueMismatch extends Schema.TaggedError<EnterpriseIssueMismatch>()(
  "EnterpriseIssueMismatch",
  {},
) {
  override get message(): string {
    return "Imported issue identity does not match the requested URL.";
  }
}
export class EnterpriseIssueService extends Context.Service<
  EnterpriseIssueService,
  {
    readonly loadContext: (
      url: string,
    ) => Effect.Effect<string, EnterpriseIssueError | EnterpriseIssueMismatch>;
    readonly importIssue: (input: {
      readonly url: string;
      readonly outputPath: string;
    }) => Effect.Effect<void, EnterpriseIssueError | EnterpriseIssueMismatch>;
  }
>()("t3/enterprise/EnterpriseIssueService") {}
const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const loadContext = Effect.fn("EnterpriseIssueService.loadContext")(function* (inputUrl: string) {
    const url = yield* decodeUrl(inputUrl).pipe(
      Effect.mapError((cause) => new EnterpriseIssueError({ stage: "validate", cause })),
    );
    const output = yield* runner
      .run({
        command: "gh",
        args: ["issue", "view", url, "--json", "number,title,body,url"],
        timeout: "30 seconds",
        maxOutputBytes: 1_048_576,
      })
      .pipe(Effect.mapError((cause) => new EnterpriseIssueError({ stage: "fetch", cause })));
    if (output.code !== 0 || output.timedOut || output.stdoutTruncated || output.stdoutInvalidUtf8)
      return yield* new EnterpriseIssueError({ stage: "fetch", cause: output.code });
    const issue = yield* decodeIssue(output.stdout).pipe(
      Effect.mapError((cause) => new EnterpriseIssueError({ stage: "decode", cause })),
    );
    if (issue.url !== url || issue.number !== Number(url.split("/").at(-1)))
      return yield* new EnterpriseIssueMismatch({});
    const contents = yield* encodeArtifact({
      source: "github_issue",
      trust: "untrusted_content",
      issue: {
        ...issue,
        title: redactEnterpriseSecrets(issue.title),
        body: redactEnterpriseSecrets(issue.body),
      },
    }).pipe(Effect.mapError((cause) => new EnterpriseIssueError({ stage: "decode", cause })));
    return contents;
  });
  const importIssue = Effect.fn("EnterpriseIssueService.importIssue")(function* (input: {
    readonly url: string;
    readonly outputPath: string;
  }) {
    const contents = yield* loadContext(input.url);
    yield* writeFileStringAtomically({ filePath: input.outputPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => new EnterpriseIssueError({ stage: "write", cause })),
    );
  });
  return EnterpriseIssueService.of({ importIssue, loadContext });
});
export const layer = Layer.effect(EnterpriseIssueService, make);
