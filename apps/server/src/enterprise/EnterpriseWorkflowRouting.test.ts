import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnterpriseAdvanceWorkflowInput,
  EnterpriseRoleError,
  EnterprisePullRequestDraft,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type EnterpriseRole,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Roles from "./EnterpriseRoleService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";
import * as Workflow from "./EnterpriseWorkflowService.ts";
import { EnterprisePricing } from "./EnterprisePricing.ts";

const decodeWorkflow = Schema.decodeUnknownEffect(EnterpriseAdvanceWorkflowInput);
const identity = "a".repeat(64);
const threadId = (role: EnterpriseRole) => ThreadId.make(`enterprise:${identity}:${role}`);
const check = {
  name: "test",
  kind: "test",
  status: "passed",
  commitSha: "b".repeat(40),
  artifactIds: ["gate"],
};
const draft = Schema.decodeUnknownSync(EnterprisePullRequestDraft)({
  evidence: {
    taskId: "task:route",
    diffSha: "b".repeat(40),
    tests: [check],
    securityScan: { ...check, kind: "security_scan" },
    cost: { currency: "USD", amountCents: 0 },
    provenance: {
      threadId: "thread:1",
      runId: "run:1",
      commitSha: "b".repeat(40),
      artifactIds: ["gate"],
    },
  },
  body: "verified",
  approvalStatus: "not_evaluated",
});
const scenario = (
  mode:
    | "docs"
    | "code"
    | "local_down"
    | "no_fallback"
    | "limited"
    | "no_cloud"
    | "no_prices"
    | "unpriced"
    | "expired_limit",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-routing-" });
    const input = yield* decodeWorkflow({
      task: {
        taskId: "task:route",
        projectId: "project:1",
        tenantId: "local",
        repoCommit: "b".repeat(40),
        acceptanceCriteria: ["done"],
        approvedTools: ["codex.workspace_read", "codex.workspace_write", "/usr/bin/true"],
        budgetLimit: { currency: "USD", limitCents: 150 },
      },
      repositoryRoot: root,
      workspacesRoot: `${root}/tasks`,
      issueContext: "issue",
      modelSelection: { instanceId: "codex", model: "default" },
      plan: ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
        kind,
        name: kind,
        tool: "/usr/bin/true",
        args: [],
        timeoutMs: 1000,
      })),
      routing: {
        candidates: [
          ...(mode === "no_cloud"
            ? []
            : ["cloud-a", "cloud-b"].map((model) => ({
                selection: { instanceId: "codex", model },
                tier: "cloud",
              }))),
          { selection: { instanceId: "codex", model: "ollama/local" }, tier: "local" },
        ],
        preferLocalDocs: true,
        allowCloudFallback: mode !== "no_fallback",
      },
    });
    const stored = new Map<ThreadId, OrchestrationV2ThreadProjection>();
    const launches: Array<{ role: string; model: string }> = [];
    const retries: string[] = [];
    const roles = {
      launch: (value: Parameters<Roles.EnterpriseRoleService["Service"]["launch"]>[0]) =>
        Effect.gen(function* () {
          launches.push({ role: value.role, model: value.modelSelection.model });
          if (
            ["local_down", "no_fallback"].includes(mode) &&
            value.modelSelection.model.startsWith("ollama/")
          )
            return yield* new EnterpriseRoleError({ reason: "provider_unsupported" });
          const id = threadId(value.role);
          const now = yield* DateTime.now;
          stored.set(id, {
            thread: {
              id,
              worktreePath: root,
              deletedAt: null,
              archivedAt: null,
              modelSelection: value.modelSelection,
            },
            runs: [
              {
                id: `run:${value.role}`,
                userMessageId: `${id}:initial`,
                modelSelection: value.modelSelection,
                status:
                  (mode === "limited" || mode === "expired_limit") && value.role === "architect"
                    ? "failed"
                    : "completed",
                checkpointId: `checkpoint:${value.role}`,
                completedAt:
                  mode === "expired_limit" ? DateTime.subtract(now, { minutes: 10 }) : now,
              },
            ],
            providerTurns: [],
            turnItems:
              mode === "limited" || mode === "expired_limit"
                ? [
                    {
                      type: "error",
                      runId: "run:architect",
                      failure: { class: "usage_limit", code: "429", retryable: true },
                    },
                  ]
                : [],
            checkpoints: [{ id: `checkpoint:${value.role}`, status: "ready" }],
          } as unknown as OrchestrationV2ThreadProjection);
          return { threadId: id, resumed: false };
        }),
      retry: (value: Parameters<Roles.EnterpriseRoleService["Service"]["retry"]>[0]) =>
        Effect.sync(() => {
          retries.push(value.modelSelection.model);
          return { threadId: threadId(value.role) };
        }),
      collectRoleArtifact: (value: { role: EnterpriseRole }) =>
        Effect.succeed({
          output:
            value.role === "architect"
              ? {
                  kind: "enterprise_spec",
                  affectedPaths: [mode === "code" ? "src/auth.ts" : "README.md"],
                }
              : { kind: "enterprise_qa", verdict: "pass" },
        }),
      collectHandoff: () => Effect.succeed({}),
      gateAndContinue: () => Effect.succeed({ status: "passed", gate: { artifactId: "gate" } }),
      buildPullRequestDraft: () => Effect.succeed(draft),
    } as unknown as Roles.EnterpriseRoleService["Service"];
    const layer = Workflow.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Roles.EnterpriseRoleService, roles),
          Layer.succeed(EnterprisePricing, {
            load: Effect.succeed(
              mode === "no_prices"
                ? undefined
                : mode === "unpriced"
                  ? {}
                  : Object.fromEntries(
                      ["cloud-a", "cloud-b", "ollama/local"].map((model) => [
                        model,
                        { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
                      ]),
                    ),
            ),
          }),
          Layer.mock(Workspace.EnterpriseWorkspaceService)({
            prepare: () =>
              Effect.succeed({
                branch: `enterprise/task-${identity}`,
                worktreePath: root,
                boundThreadIds: ["architect", "coder", "qa"].map((role) =>
                  threadId(role as EnterpriseRole),
                ),
              } as unknown as ReturnType<
                Workspace.EnterpriseWorkspaceService["Service"]["prepare"]
              > extends Effect.Effect<infer A, unknown, unknown>
                ? A
                : never),
            bindWorkflow: () => Effect.void,
          }),
          Layer.mock(Projects.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: root } as never)),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getProjectThread: ({ threadId: id, projectId }) =>
              stored.has(id)
                ? Effect.succeed(stored.get(id)!)
                : Effect.fail(
                    new Threads.ThreadManagementThreadNotFoundError({ threadId: id, projectId }),
                  ),
          }),
        ),
      ),
    );
    const results = yield* Effect.gen(function* () {
      const service = yield* Workflow.EnterpriseWorkflowService;
      const first = yield* service.advance(input).pipe(Effect.result);
      const second = yield* service.advance(input).pipe(Effect.result);
      const third = yield* service.advance(input).pipe(Effect.result);
      const fourth = yield* service.advance(input).pipe(Effect.result);
      return [first, second, third, fourth];
    }).pipe(Effect.provide(layer));
    return { results, launches, retries };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("workflow routing integration", () => {
  it.effect("routes a docs-only Coder local while Architect and QA use cloud", () =>
    Effect.gen(function* () {
      const result = yield* scenario("docs");
      assert.deepEqual(result.launches, [
        { role: "architect", model: "cloud-a" },
        { role: "coder", model: "ollama/local" },
        { role: "qa", model: "cloud-a" },
      ]);
      const last = result.results.at(-1)!;
      assert.equal(last._tag, "Success");
      if (last._tag === "Success") assert.equal(last.success.state, "ready");
    }),
  );
  it.effect("keeps source code and auth changes on cloud", () =>
    Effect.gen(function* () {
      const result = yield* scenario("code");
      assert.isTrue(result.launches.every((launch) => launch.model === "cloud-a"));
    }),
  );
  it.effect("falls back before dispatch only when explicitly enabled", () =>
    Effect.gen(function* () {
      const allowed = yield* scenario("local_down");
      assert.deepEqual(allowed.launches.slice(1, 3), [
        { role: "coder", model: "ollama/local" },
        { role: "coder", model: "cloud-a" },
      ]);
      const denied = yield* scenario("no_fallback");
      assert.isFalse(
        denied.launches.some((launch) => launch.role === "coder" && launch.model === "cloud-a"),
      );
    }),
  );
  it.effect("selects another cloud model after a persisted usage-limit failure", () =>
    Effect.gen(function* () {
      const result = yield* scenario("limited");
      assert.isAbove(result.retries.length, 0);
      assert.isTrue(result.retries.every((model) => model === "cloud-b"));
    }),
  );
  it.effect("blocks when the required tier has no candidate", () =>
    Effect.gen(function* () {
      const result = yield* scenario("no_cloud");
      assert.lengthOf(result.launches, 0);
    }),
  );
});

it.effect("requires configured pricing before launching a routed workflow", () =>
  Effect.gen(function* () {
    const result = yield* scenario("no_prices");
    assert.lengthOf(result.launches, 0);
    const first = result.results[0]!;
    assert.equal(first._tag, "Success");
    if (first._tag === "Success")
      assert.deepEqual(first.success, { state: "blocked", reason: "cost_unknown" });
  }),
);

it.effect("does not launch an unpriced routing candidate", () =>
  Effect.gen(function* () {
    const result = yield* scenario("unpriced");
    assert.lengthOf(result.launches, 0);
  }),
);

it.effect("chooses a different model even after the failed model cooldown expired", () =>
  Effect.gen(function* () {
    const result = yield* scenario("expired_limit");
    assert.isAbove(result.retries.length, 0);
    assert.isTrue(result.retries.every((model) => model === "cloud-b"));
  }),
);
