import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnterpriseAdvanceWorkflowInput,
  EnterprisePublicationError,
  EnterprisePullRequestDraft,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Runner from "../processRunner.ts";
import * as Workflow from "./EnterpriseWorkflowService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import * as Publication from "./EnterprisePublicationService.ts";

const sha = "a".repeat(40);
const decodeWorkflow = Schema.decodeUnknownSync(EnterpriseAdvanceWorkflowInput);
const decodeDraft = Schema.decodeUnknownSync(EnterprisePullRequestDraft);
const check = {
  name: "tests",
  kind: "test",
  status: "passed",
  commitSha: sha,
  artifactIds: ["gate"],
};
const draft = decodeDraft({
  evidence: {
    taskId: "task:publish",
    diffSha: sha,
    tests: [check],
    securityScan: { ...check, kind: "security_scan" },
    cost: { currency: "USD", amountCents: 10 },
    provenance: { threadId: "thread:1", runId: "run:1", commitSha: sha, artifactIds: ["gate"] },
  },
  body: "Verified report\n\nLiteral `$(touch /tmp/untrusted)`",
  approvalStatus: "not_evaluated",
});
const output = (stdout: string, code = 0): Runner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as Runner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const scenario = (
  mode:
    | "normal"
    | "ambiguous"
    | "mismatch"
    | "not_ready"
    | "unsafe"
    | "moved"
    | "busy"
    | "crash_recovery",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publication-test-" });
    const control = `${root}/task`;
    yield* fs.makeDirectory(`${control}/checkout`, { recursive: true });
    const workflow = decodeWorkflow({
      task: {
        taskId: "task:publish",
        tenantId: "local",
        projectId: "project:1",
        repoCommit: sha,
        acceptanceCriteria: ["fix"],
        approvedTools: [],
        budgetLimit: { currency: "USD", limitCents: 150 },
      },
      repositoryRoot: `${root}/repo`,
      workspacesRoot: root,
      issueContext: "untrusted",
      modelSelection: { instanceId: "codex", model: "model" },
      plan: ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
        name: kind,
        kind,
        tool: "/usr/bin/true",
        args: [],
        timeoutMs: 1000,
      })),
    });
    const input = { workflow, repository: "example/repo", baseBranch: "main" };
    let head = "";
    let created = false;
    let creates = 0;
    let pushes = 0;
    let body = "";
    let lease = "";
    const git = {
      execute: (request: Git.ExecuteGitInput) =>
        Effect.sync(() => {
          const args = request.args;
          if (args.includes("push")) {
            pushes++;
            lease = args.find((arg) => arg.startsWith("--force-with-lease=")) ?? "";
          }
          return {
            exitCode: (args.includes("config")
              ? mode === "unsafe"
                ? 0
                : 1
              : 0) as Git.ExecuteGitResult["exitCode"],
            stdout: args.includes("ls-remote") && mode === "moved" ? `wrong\t${args.at(-1)}` : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    } as unknown as Git.GitVcsDriver["Service"];
    const runner = {
      run: (request: Runner.ProcessRunInput) =>
        Effect.gen(function* () {
          head = request.args[request.args.indexOf("--head") + 1]!;
          if (request.args[1] === "create") {
            creates++;
            const bodyPath = request.args[request.args.indexOf("--body-file") + 1]!;
            body = yield* fs.readFileString(bodyPath).pipe(Effect.orDie);
            created = mode !== "ambiguous";
            if (mode === "ambiguous" || mode === "crash_recovery") return output("", 1);
            return output("https://github.com/example/repo/pull/7");
          }
          return output(
            JSON.stringify(
              created
                ? [
                    {
                      number: 7,
                      url: "https://github.com/example/repo/pull/7",
                      headRefName: head,
                      headRefOid: mode === "mismatch" ? "b".repeat(40) : sha,
                      baseRefName: "main",
                      isDraft: true,
                      isCrossRepository: false,
                      state: "OPEN",
                    },
                  ]
                : [],
            ),
          );
        }),
    };
    const layer = Publication.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Git.GitVcsDriver, git),
          Layer.succeed(Runner.ProcessRunner, runner),
          Layer.succeed(Workspace.EnterpriseWorkspaceService, {
            prepare: () => Effect.succeed({ worktreePath: `${control}/checkout` }),
          } as unknown as Workspace.EnterpriseWorkspaceService["Service"]),
          Layer.succeed(Workflow.EnterpriseWorkflowService, {
            advance: () =>
              Effect.succeed(
                mode === "not_ready"
                  ? { state: "blocked" as const, reason: "failed_run" as const }
                  : { state: "ready" as const, revision: 0 as const, draft },
              ),
          }),
        ),
      ),
    );
    const results = yield* Effect.gen(function* () {
      const service = yield* Publication.EnterprisePublicationService;
      if (mode === "busy")
        yield* fs.makeDirectory(`${control}/publication.lock`).pipe(Effect.orDie);
      const first = yield* service.publish(input).pipe(Effect.result);
      const second = yield* service.publish(input).pipe(Effect.result);
      return { first, second };
    }).pipe(Effect.provide(layer));
    return {
      ...results,
      creates,
      pushes,
      body,
      lease,
      locked: yield* fs.exists(`${control}/publication.lock`),
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const reason = (result: { readonly _tag: string; readonly failure?: unknown }) => {
  assert.equal(result._tag, "Failure");
  assert.instanceOf(result.failure, EnterprisePublicationError);
  return (result.failure as EnterprisePublicationError).reason;
};
describe("Enterprise draft PR publication", () => {
  it.effect("uploads the verified checkpoint once and reconciles retries without another PR", () =>
    Effect.gen(function* () {
      const result = yield* scenario("normal");
      assert.equal(result.first._tag, "Success");
      assert.equal(result.second._tag, "Success");
      assert.equal(result.creates, 1);
      assert.equal(result.pushes, 1);
      assert.equal(result.body, draft.body);
      assert.include(result.lease, "--force-with-lease=refs/heads/enterprise/pr-");
      assert.isFalse(result.locked);
      if (result.second._tag === "Success") assert.isTrue(result.second.success.reconciled);
    }),
  );
  it.effect("never repeats an ambiguous create when GitHub has not returned a PR", () =>
    Effect.gen(function* () {
      const result = yield* scenario("ambiguous");
      assert.equal(reason(result.first), "remote_failed");
      assert.equal(reason(result.second), "publication_unknown");
      assert.equal(result.creates, 1);
      assert.isFalse(result.locked);
    }),
  );
  it.effect("recovers when remote creation succeeded but the local call failed", () =>
    Effect.gen(function* () {
      const result = yield* scenario("crash_recovery");
      assert.equal(reason(result.first), "remote_failed");
      assert.equal(result.second._tag, "Success");
      assert.equal(result.creates, 1);
    }),
  );
  it.effect.each([
    ["not_ready", "workflow_not_ready"],
    ["unsafe", "unsafe_git_config"],
    ["moved", "remote_mismatch"],
    ["busy", "busy"],
  ] as const)("rejects %s before publishing", ([mode, expected]) =>
    Effect.gen(function* () {
      const result = yield* scenario(mode);
      assert.equal(reason(result.first), expected);
      assert.equal(result.creates, 0);
      assert.equal(result.pushes, 0);
    }),
  );
  it.effect("refuses an existing PR whose head no longer matches the evidence", () =>
    Effect.gen(function* () {
      const result = yield* scenario("mismatch");
      assert.equal(reason(result.first), "remote_mismatch");
      assert.equal(reason(result.second), "remote_mismatch");
      assert.equal(result.creates, 1);
    }),
  );
});
