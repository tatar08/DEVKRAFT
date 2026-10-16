import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CliError, Command, Flag } from "effect/cli";

import * as CostReport from "../enterprise/EnterpriseCostReport.ts";
import * as Merge from "../enterprise/EnterpriseMergeService.ts";
import * as Issue from "../enterprise/EnterpriseIssueService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Workspace from "../enterprise/EnterpriseWorkspaceService.ts";

import * as EnterpriseEvidence from "../enterprise/EnterpriseEvidenceService.ts";

const verifyCommand = Command.make("verify", {
  bundlePath: Flag.String("bundle"),
  currentCommitSha: Flag.String("commit"),
  currentPolicyVersion: Flag.String("policy-version"),
}).pipe(
  Command.withDescription(
    "Validate declared task evidence against a commit, budget and approval policy. Does not run checks or authorize a merge.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* EnterpriseEvidence.EnterpriseEvidenceService;
      const task = yield* service
        .verifyFile(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log(
        `Declared evidence checks passed for ${task.taskId}. Artifact authenticity and actor permissions require independent verification.`,
      );
    }).pipe(Effect.provide(EnterpriseEvidence.layer)),
  ),
);

const workspaceFlags = {
  specPath: Flag.String("spec"),
  repositoryRoot: Flag.String("repo"),
  workspacesRoot: Flag.String("workspaces-root"),
};
const prepareCommand = Command.make("prepare", workspaceFlags).pipe(
  Command.withDescription(
    "Prepare an owned task worktree at its pinned commit without hooks or submodule setup.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Workspace.EnterpriseWorkspaceService;
      const result = yield* service
        .prepareFile(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log(result.worktreePath);
    }).pipe(Effect.provide(Workspace.layer)),
  ),
);
const cleanupCommand = Command.make("cleanup", workspaceFlags).pipe(
  Command.withDescription(
    "Remove only an owned pristine base worktree. Retains branches and rejects busy or modified workspaces.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Workspace.EnterpriseWorkspaceService;
      const result = yield* service
        .cleanupFile(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log(result.status);
    }).pipe(Effect.provide(Workspace.layer)),
  ),
);
const checkCommand = Command.make("check", {
  ...workspaceFlags,
  checkPath: Flag.String("check"),
}).pipe(
  Command.withDescription(
    "Run one allowlisted check in Linux Bubblewrap with network and resource limits. Never falls back to host execution.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Workspace.EnterpriseWorkspaceService;
      yield* service
        .checkFile(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log(
        "Sandbox check passed; evidence artifact recorded beside the owned worktree.",
      );
    }).pipe(Effect.provide(Workspace.layer)),
  ),
);
const gateCommand = Command.make("gate", { ...workspaceFlags, planPath: Flag.String("plan") }).pipe(
  Command.withDescription(
    "Run the required test/lint/typecheck/security checks at one clean commit under one ownership lock; records evidence only if all pass.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Workspace.EnterpriseWorkspaceService;
      const result = yield* service
        .gateFile(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log(
        `Deterministic gate passed; evidence saved beside ${result.worktreePath}.`,
      );
    }).pipe(Effect.provide(Workspace.layer)),
  ),
);
const worktreeCommand = Command.make("worktree").pipe(
  Command.withSubcommands([prepareCommand, cleanupCommand, checkCommand, gateCommand]),
);

const importIssueCommand = Command.make("import", {
  url: Flag.String("url"),
  outputPath: Flag.String("output"),
}).pipe(
  Command.withDescription(
    "Import one GitHub issue as untrusted task context. Does not execute instructions from the issue.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Issue.EnterpriseIssueService;
      yield* service
        .importIssue(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log("GitHub issue context saved. Tool grants must come from the task policy.");
    }).pipe(Effect.provide(Issue.layer.pipe(Layer.provide(ProcessRunner.layer)))),
  ),
);
const issueCommand = Command.make("issue").pipe(Command.withSubcommands([importIssueCommand]));

const mergeCommand = Command.make("merge-check", {
  repositoryRoot: Flag.String("repo"),
  targetCommit: Flag.String("target-commit"),
  taskCommit: Flag.String("task-commit"),
}).pipe(
  Command.withDescription(
    "Serialize merge feasibility checks across repository worktrees; does not update refs or authorize merging.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Merge.EnterpriseMergeService;
      const result = yield* service
        .check(input)
        .pipe(
          Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
        );
      yield* Console.log(
        `Merge preflight passed: ${result.treeSha}. Recheck against the current target before merging.`,
      );
    }).pipe(Effect.provide(Merge.layer)),
  ),
);

const encodeReport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const costCommand = Command.make("cost", {
  usagePath: Flag.String("usage"),
  pricingPath: Flag.String("pricing"),
  projectId: Flag.String("project"),
  markupBps: Flag.Int("markup-bps").pipe(Flag.withDefault(0)),
}).pipe(
  Command.withDescription(
    "Summarize provider cost and billed cost (with project markup in basis points) from a usage export. Unpriced usage is reported, never free.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const report = yield* CostReport.buildCostReport(input).pipe(
        Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
      );
      yield* Console.log(encodeReport(report));
    }),
  ),
);

export const enterpriseCommand = Command.make("enterprise").pipe(
  Command.withDescription("Inspect Enterprise workflow evidence."),
  Command.withSubcommands([
    verifyCommand,
    worktreeCommand,
    issueCommand,
    mergeCommand,
    costCommand,
  ]),
);
