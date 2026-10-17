// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side acceptance harness owns processes, transport and deadlines.
/** Opt-in Issue → real V2 roles → sandbox gates → draft acceptance.
 * Local (no GitHub writes):
 *   node apps/server/scripts/verify-enterprise-live.ts --scratch /path/outside/tmp --scenario docs
 * Remote (Phase 2 live acceptance; clones OWNER/REPO, imports a real issue with the installed `gh`,
 * publishes one draft PR, then publishes again to prove reconciliation creates no duplicate):
 *   node apps/server/scripts/verify-enterprise-live.ts --scratch /path --remote OWNER/REPO --issue 1
 * Uses the current Codex authentication and local Ollama. Retains only disposable test state.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";
import { WsRpcGroup } from "@t3tools/contracts";
import {
  createLiveFixture,
  startLiveServer,
  stopLiveServer,
  makeLiveWorkflow,
  readLiveAdvanceInput,
} from "./enterpriseLiveHarness.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    scratch: { type: "string" },
    scenario: { type: "string", default: "docs" },
    model: { type: "string", default: "gpt-6.1-sol" },
    remote: { type: "string" },
    issue: { type: "string" },
    server: { type: "string", default: "dist" },
  },
});
const remote = values.remote;
NodeAssert.ok(
  remote === undefined ||
    (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote) && /^[1-9][0-9]*$/.test(values.issue ?? "")),
  "--remote OWNER/REPO requires --issue NUMBER",
);
NodeAssert.ok(values.server === "dist" || values.server === "source");
NodeAssert.ok(
  values.scratch && !NodePath.resolve(values.scratch).startsWith("/tmp/"),
  "Specify writable scratch outside /tmp",
);
NodeAssert.ok(values.scenario === "docs" || values.scenario === "code");
// The remote fixture is the calculator bug; its issue asks for a code change.
if (remote !== undefined) values.scenario = "code";
NodeAssert.equal(
  values.model,
  "gpt-6.1-sol",
  "This acceptance fixture pins its measured model and explicit pricing.",
);
const fixture = createLiveFixture({
  ...values,
  scratch: values.scratch,
  scenario: values.scenario === "docs" ? "docs" : "code",
});
const { evidence, home, repo, tasks, git, docs, issue, commit } = fixture;
const running = await startLiveServer(fixture, values.server);
const { server } = running;
const abort = new AbortController();
const onSignal = () => {
  const error = new Error("Acceptance interrupted");
  abort.abort(error);
  running.interrupt(error);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
let verdict: object = { passed: false };
console.log(`Evidence: ${evidence}`);
try {
  await running.ready;
  const { protocol, createProject } = await running.connect();
  const projectId = await createProject(repo);
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const workflow = yield* makeLiveWorkflow(fixture, projectId);
    let { state } = yield* client["enterprise.startIssueWorkflow"]({
      workflow,
      issueUrl: issue.url,
    });
    // Exercise authenticated start/import; advance deterministically from committed V2 events here.
    yield* client["enterprise.stopWorkflow"]({
      task: workflow.task,
      repositoryRoot: repo,
      workspacesRoot: tasks,
    });
    const input = yield* readLiveAdvanceInput(tasks);
    NodeAssert.equal(JSON.parse(input.issueContext).trust, "untrusted_content");
    const stages: object[] = [];
    const selections: Array<{ role: string; model: string }> = [];
    for (let step = 0; step < 16; step++) {
      yield* Effect.log(
        `Stage: ${state.state}${"role" in state ? ` ${state.role} revision ${state.revision}` : ""}`,
      );
      stages.push(
        state.state === "ready" ? { state: state.state, revision: state.revision } : state,
      );
      if (state.state === "blocked") throw new Error(`Workflow blocked: ${state.reason}`);
      if (state.state === "ready") {
        const repeat = yield* client["enterprise.advanceWorkflow"](input);
        NodeAssert.equal(repeat.state, "ready");
        NodeFS.writeFileSync(
          NodePath.join(evidence, "draft.json"),
          JSON.stringify(state.draft, null, 2),
        );
        const files = git("diff", "--name-only", commit, state.draft.evidence.diffSha).split("\n");
        NodeAssert.deepEqual(files, [docs ? "GUIDE.md" : "calc.py"]);
        let remotePublication: object | string = "not attempted";
        if (remote !== undefined) {
          const publish = { workflow: input, repository: remote, baseBranch: "main" };
          const first = yield* client["enterprise.publishPullRequest"](publish);
          // A second identical request must reconcile to the same PR, never create another.
          const second = yield* client["enterprise.publishPullRequest"](publish);
          NodeAssert.equal(second.number, first.number);
          NodeAssert.equal(second.reconciled, true);
          NodeAssert.equal(first.commitSha, state.draft.evidence.diffSha);
          const listed = JSON.parse(
            NodeChildProcess.execFileSync(
              "gh",
              ["pr", "list", "--repo", remote, "--head", first.headBranch, "--state", "all"].concat(
                ["--json", "number,isDraft,headRefOid"],
              ),
              { encoding: "utf8" },
            ),
          ) as Array<{ number: number; isDraft: boolean; headRefOid: string }>;
          NodeAssert.equal(listed.length, 1);
          NodeAssert.ok(listed[0]!.isDraft);
          NodeAssert.equal(listed[0]!.headRefOid, first.commitSha);
          remotePublication = { first, second, pullRequestsForHead: listed.length };
        }
        verdict = {
          passed: true,
          scenario: values.scenario,
          issueSource: remote === undefined ? "local gh fixture; no remote access" : issue.url,
          cloudModel: values.model,
          coderBackend: docs ? "ollama/qwen3-coder:30b" : values.model,
          stages,
          selections,
          verifiedCommit: state.draft.evidence.diffSha,
          remotePublication,
          repeatedAdvance: "ready",
        };
        return;
      }
      const threadId = state.threadId;
      yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.mapEffect((item) =>
          item.kind === "snapshot"
            ? Effect.succeed(item.projection)
            : client["orchestration.getThreadProjection"]({ threadId }),
        ),
        Stream.filter((p) => {
          const run = p.runs.at(-1);
          return (
            run !== undefined &&
            (["failed", "cancelled", "interrupted"].includes(run.status) ||
              (run.status === "completed" &&
                p.checkpoints.some((c) => c.runId === run.id && c.status === "ready")))
          );
        }),
        Stream.take(1),
        Stream.runForEach((projection) =>
          Effect.sync(() => {
            const model = projection.runs.at(-1)!.modelSelection.model;
            const role = "role" in state ? state.role : "unknown";
            NodeAssert.equal(
              model,
              docs && role === "coder" ? "ollama/qwen3-coder:30b" : values.model,
            );
            selections.push({ role, model });
          }),
        ),
      );
      state = yield* client["enterprise.advanceWorkflow"](input);
    }
    throw new Error("Stage bound exhausted");
  }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("8 minutes"));
  await Effect.runPromise(program, { signal: abort.signal });
  console.log(JSON.stringify(verdict));
} catch (error) {
  verdict = {
    passed: false,
    scenario: values.scenario,
    error: String(error),
    serverExit: running.exit() ?? null,
  };
  console.error(String(error));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  NodeFS.writeFileSync(NodePath.join(evidence, "verdict.json"), JSON.stringify(verdict, null, 2));
  await stopLiveServer(server);
}

NodeFS.rmSync(home, { recursive: true, force: true });
