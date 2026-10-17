// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Opt-in host acceptance drill owns processes and deadlines.
/** Run with --scratch /persistent/path --server source|dist [--scenario between-stages|mid-turn].
 * Defaults to both scenarios in one disposable T3 home. Uses real Codex turns, but no GitHub writes.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";
import {
  WsRpcGroup,
  type ThreadId,
  type ProjectId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  createLiveFixture,
  makeLiveWorkflow,
  readLiveAdvanceInput,
  startLiveServer,
  stopLiveServer,
} from "./enterpriseLiveHarness.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    scratch: { type: "string" },
    server: { type: "string", default: "dist" },
    scenario: { type: "string" },
  },
});
NodeAssert.ok(
  values.scratch && !NodePath.resolve(values.scratch).startsWith("/tmp/"),
  "Specify writable scratch outside /tmp",
);
NodeAssert.ok(values.server === "source" || values.server === "dist", "--server source|dist");
NodeAssert.ok(
  values.scenario === undefined ||
    values.scenario === "between-stages" ||
    values.scenario === "mid-turn",
  "--scenario between-stages|mid-turn",
);
const scenarios = values.scenario ? [values.scenario] : ["between-stages", "mid-turn"];
const fixture = createLiveFixture(
  { scratch: values.scratch, scenario: "code", model: "gpt-6.1-sol" },
  "t3-enterprise-restart-",
);
const abort = new AbortController();
const onSignal = () => abort.abort(new Error("Restart drill interrupted"));
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
let running: Awaited<ReturnType<typeof startLiveServer>> | undefined;
const MAX_STAGE_ADVANCES = 16;
const SCENARIO_DEADLINE = "8 minutes";
let activeScenario: string | undefined;
let persistentProjectId: ProjectId | undefined;
const results: object[] = [];
let verdict: object = { passed: false, scenarios: results };
console.log(`Evidence: ${fixture.evidence}`);

/** Subscribe before inspecting milestones so a fast completed turn cannot be missed. */
const waitForRun = (threadId: ThreadId, midTurn = false) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    return yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.mapEffect((item) =>
        item.kind === "snapshot"
          ? Effect.succeed(item.projection)
          : client["orchestration.getThreadProjection"]({ threadId }),
      ),
      Stream.filter((p) => {
        const run = p.runs.at(-1);
        if (!run) return false;
        if (midTurn && run.status === "running") return true;
        return (
          ["failed", "cancelled", "interrupted"].includes(run.status) ||
          (run.status === "completed" &&
            p.checkpoints.some((c) => c.runId === run.id && c.status === "ready"))
        );
      }),
      Stream.take(1),
      Stream.runCollect,
      Effect.map((items) => {
        const p = items[0];
        NodeAssert.ok(p, "Thread stream ended before milestone");
        NodeAssert.equal(
          p.runs.at(-1)!.status,
          midTurn ? "running" : "completed",
          "Required crash milestone was not observed",
        );
        return p;
      }),
    );
  });

/** Count all project threads, including archived threads, rather than only the expected IDs. */
const inspectRuns = (projectId: string) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const snapshots = yield* client["orchestration.subscribeShell"]({}).pipe(
      Stream.filter((item) => item.kind === "snapshot"),
      Stream.take(1),
      Stream.runCollect,
    );
    const item = snapshots[0];
    NodeAssert.ok(item?.kind === "snapshot");
    const threads = [...item.snapshot.threads, ...item.snapshot.archivedThreads].filter(
      (t) => t.projectId === projectId,
    );
    const projections: OrchestrationV2ThreadProjection[] = [];
    for (const thread of threads)
      projections.push(yield* client["orchestration.getThreadProjection"]({ threadId: thread.id }));
    return projections.map((p) => ({
      threadId: p.thread.id,
      runIds: p.runs.map((r) => r.id),
      runCount: p.runs.length,
      initialRunCount: p.runs.filter((r) => r.userMessageId.endsWith(":initial")).length,
    }));
  });

try {
  for (const scenario of scenarios) {
    activeScenario = scenario;
    console.log(`Scenario: ${scenario}`);
    running = await startLiveServer(fixture, values.server);
    await running.ready;
    const connection = await running.connect();
    const scenarioFixture = { ...fixture, tasks: NodePath.join(fixture.tasks, scenario) };
    const crashedServer = running.server;
    persistentProjectId ??= await connection.createProject(fixture.repo);
    const projectId = persistentProjectId;
    const before = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        const counts = yield* inspectRuns(projectId);
        const workflow = yield* makeLiveWorkflow(scenarioFixture, projectId, `restart:${scenario}`);
        let { state } = yield* client["enterprise.startIssueWorkflow"]({
          workflow,
          issueUrl: fixture.issue.url,
        });
        yield* client["enterprise.stopWorkflow"]({
          task: workflow.task,
          repositoryRoot: fixture.repo,
          workspacesRoot: scenarioFixture.tasks,
        });
        const input = yield* readLiveAdvanceInput(scenarioFixture.tasks);
        NodeAssert.equal(
          input.task.taskId,
          workflow.task.taskId,
          "Selected another workflow's automation record",
        );
        for (let step = 0; step < MAX_STAGE_ADVANCES; step++) {
          NodeAssert.ok(
            state.state === "running" || state.state === "waiting_checkpoint",
            `Unexpected pre-crash state: ${state.state}`,
          );
          if (state.role === "coder") {
            const projection = yield* waitForRun(state.threadId, scenario === "mid-turn");
            // Leave the RPC scope before killing: a socket torn down mid-read would fail this
            // program instead of returning the milestone the crash is taken at.
            return {
              input,
              coderThreadId: state.threadId,
              coderRunId: projection.runs.at(-1)!.id,
              counts,
            };
          }
          yield* waitForRun(state.threadId);
          state = yield* client["enterprise.advanceWorkflow"](input);
        }
        throw new Error("Coder milestone stage bound exhausted");
      }).pipe(
        Effect.scoped,
        Effect.provide(connection.protocol),
        Effect.timeout(SCENARIO_DEADLINE),
      ),
      { signal: abort.signal },
    );
    // Crash at the observed milestone: SIGKILL the captured group, including provider children.
    await stopLiveServer(crashedServer, "SIGKILL");
    running = await startLiveServer(fixture, values.server);
    await running.ready;
    const restarted = await running.connect();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        let state = yield* client["enterprise.advanceWorkflow"](before.input);
        if (scenario === "between-stages") {
          for (let step = 0; step < MAX_STAGE_ADVANCES && state.state !== "ready"; step++) {
            NodeAssert.ok(
              state.state === "running" || state.state === "waiting_checkpoint",
              `Workflow did not recover: ${JSON.stringify(state)}`,
            );
            yield* waitForRun(state.threadId);
            state = yield* client["enterprise.advanceWorkflow"](before.input);
          }
          NodeAssert.equal(state.state, "ready", "Recovery stage bound exhausted");
        } else {
          NodeAssert.ok(
            (state.state === "blocked" && state.reason === "failed_run") ||
              (state.state === "running" && state.threadId === before.coderThreadId),
            `Unexpected mid-turn recovery: ${JSON.stringify(state)}`,
          );
        }
        const verifiedCommit = state.state === "ready" ? state.draft.evidence.diffSha : null;
        const repeat = yield* client["enterprise.advanceWorkflow"](before.input);
        if (state.state === "ready") {
          NodeAssert.equal(repeat.state, "ready");
          NodeAssert.ok(repeat.state === "ready");
          NodeAssert.equal(repeat.draft.evidence.diffSha, verifiedCommit);
        } else {
          NodeAssert.ok(
            (repeat.state === "blocked" && repeat.reason === "failed_run") ||
              (repeat.state === "running" && repeat.threadId === before.coderThreadId),
          );
        }
        const counts = yield* inspectRuns(projectId);
        const expectedRoles =
          scenario === "between-stages" ? ["architect", "coder", "qa"] : ["architect", "coder"];
        const prefix = before.coderThreadId.slice(0, -"coder".length);
        const baselineIds = before.counts
          .filter((c) => !c.threadId.startsWith(prefix))
          .map((c) => c.threadId);
        NodeAssert.deepEqual(
          counts.map((c) => c.threadId).sort(),
          [...baselineIds, ...expectedRoles.map((role) => `${prefix}${role}`)].sort(),
          "Unexpected role threads",
        );
        for (const count of counts) {
          NodeAssert.equal(count.initialRunCount, 1, `Duplicate initial run: ${count.threadId}`);
          NodeAssert.equal(count.runCount, 1, `Unexpected extra run: ${count.threadId}`);
        }
        const coder = counts.find((c) => c.threadId === before.coderThreadId);
        NodeAssert.deepEqual(coder?.runIds, [before.coderRunId], "Coder was silently replayed");
        return {
          scenario,
          passed: true,
          outcome: state.state,
          repeatedOutcome: repeat.state,
          before: before.counts,
          threadRunCounts: counts,
          verifiedCommit,
          repeatedVerifiedCommit: repeat.state === "ready" ? repeat.draft.evidence.diffSha : null,
        };
      }).pipe(Effect.scoped, Effect.provide(restarted.protocol), Effect.timeout(SCENARIO_DEADLINE)),
      { signal: abort.signal },
    );
    results.push(result);
    await stopLiveServer(running.server);
    running = undefined;
  }
  verdict = { passed: true, scenarios: results };
} catch (error) {
  verdict = {
    passed: false,
    scenarios: results,
    failedScenario: activeScenario,
    error: String(error),
    serverExit: running?.exit() ?? null,
  };
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  NodeFS.writeFileSync(
    NodePath.join(fixture.evidence, "restart-drill-verdict.json"),
    JSON.stringify(verdict, null, 2),
  );
  if (running) await stopLiveServer(running.server);
  NodeFS.rmSync(fixture.home, { recursive: true, force: true });
}
console.log(JSON.stringify(verdict));
