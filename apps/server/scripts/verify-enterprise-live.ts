// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side acceptance harness owns processes, transport and deadlines.
/** Opt-in local Issue fixture → real V2 roles → sandbox gates → draft, with no GitHub writes.
 * node apps/server/scripts/verify-enterprise-live.ts --scratch /path/outside/tmp --scenario docs
 * Uses the current Codex authentication and local Ollama. Retains only disposable test state.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  EnterpriseAdvanceWorkflowInput,
  EnterpriseStartIssueWorkflowInput,
  ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeWorkflow = Schema.decodeUnknownEffect(
  EnterpriseStartIssueWorkflowInput.fields.workflow,
);
const decodeAdvance = Schema.decodeUnknownEffect(EnterpriseAdvanceWorkflowInput);
const { values } = NodeUtil.parseArgs({
  options: {
    scratch: { type: "string" },
    scenario: { type: "string", default: "docs" },
    model: { type: "string", default: "gpt-6.1-sol" },
  },
});
NodeAssert.ok(
  values.scratch && !NodePath.resolve(values.scratch).startsWith("/tmp/"),
  "Specify writable scratch outside /tmp",
);
NodeAssert.ok(values.scenario === "docs" || values.scenario === "code");
NodeAssert.equal(
  values.model,
  "gpt-6.1-sol",
  "This acceptance fixture pins its measured model and explicit pricing.",
);
const root = NodePath.resolve(import.meta.dirname, "../../..");
const evidence = NodeFS.mkdtempSync(
  NodePath.join(NodePath.resolve(values.scratch), "t3-enterprise-live-"),
);
const home = NodePath.join(evidence, "home");
const repo = NodePath.join(evidence, "repo");
const tasks = NodePath.join(evidence, "tasks");
const bin = NodePath.join(evidence, "bin");
NodeFS.mkdirSync(repo);
NodeFS.mkdirSync(bin);
NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
const git = (...args: string[]) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
git("init", "-q");
const docs = values.scenario === "docs";
const expected = "# Quickstart\n\nRetries: 2\nTimeout: 30 seconds\n\nPreserve this footer.\n";
NodeFS.writeFileSync(
  NodePath.join(repo, "REFERENCE.md"),
  "# Service limits\n\nRetries: 2\nTimeout: 30 seconds\n",
);
NodeFS.writeFileSync(
  NodePath.join(repo, "GUIDE.md"),
  "# Quickstart\n\nRetries: 9\nTimeout: 10 seconds\n\nPreserve this footer.\n",
);
NodeFS.writeFileSync(NodePath.join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
NodeFS.writeFileSync(
  NodePath.join(repo, "test_calc.py"),
  "import unittest\nfrom calc import add\nclass Addition(unittest.TestCase):\n    def test_positive(self): self.assertEqual(add(4, 2), 6)\n    def test_negative(self): self.assertEqual(add(-4, -2), -6)\n    def test_zero(self): self.assertEqual(add(3, 0), 3)\n",
);
git("add", ".");
git("commit", "-qm", "acceptance baseline");
const commit = git("rev-parse", "HEAD");
const issue = {
  number: 1,
  title: docs ? "Synchronize quickstart limits" : "Correct calculator addition",
  body: docs
    ? "Fix GUIDE.md retry count and timeout to match REFERENCE.md. Preserve every other byte. Only change GUIDE.md."
    : "Fix calc.py add(a,b) to return the sum. Positive, negative and zero inputs must pass test_calc.py. Only change calc.py.",
  url: "https://github.com/local-fixture/enterprise-acceptance/issues/1",
};
// The executable only implements issue reads; every other GitHub command fails closed.
NodeFS.writeFileSync(
  NodePath.join(bin, "gh"),
  `#!${process.execPath}\nif(process.argv.slice(2).join(' ')!==${JSON.stringify(`issue view ${issue.url} --json number,title,body,url`)})process.exit(91);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(issue))});\n`,
  { mode: 0o700 },
);
NodeFS.writeFileSync(
  NodePath.join(home, "userdata", "enterprise-pricing.json"),
  JSON.stringify({
    version: 1,
    models: {
      [values.model!]: {
        inputCentsPerMillion: 200,
        cachedInputCentsPerMillion: 10,
        outputCentsPerMillion: 1000,
      },
      "ollama/qwen3-coder:30b": { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
    },
  }),
);
const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((r) => reservation.once("listening", r));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((r) => reservation.close(() => r()));
const origin = `http://127.0.0.1:${address.port}`;
const bootstrap = NodeCrypto.randomUUID();
const server = NodeChildProcess.spawn(
  process.execPath,
  ["apps/server/dist/bin.mjs", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
  {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  },
);
const pipe = server.stdio[3];
NodeAssert.ok(pipe && "end" in pipe);
pipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port: address.port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
let serverExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
server.once("exit", (code, signal) => {
  serverExit = { code, signal };
});
const ready = Promise.withResolvers<void>();
let log = "";
for (const output of [server.stdout, server.stderr])
  output?.on("data", (data) => {
    log = (log + data.toString()).slice(-16000);
    if (log.includes("startup phase: complete")) ready.resolve();
  });
server.once("error", ready.reject);
server.once("exit", () => ready.reject(new Error("Server exited before ready")));
const abort = new AbortController();
const onSignal = () => {
  const error = new Error("Acceptance interrupted");
  abort.abort(error);
  ready.reject(error);
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
const startupDeadline = setTimeout(() => ready.reject(new Error("Startup timed out")), 30000);
let verdict: object = { passed: false };
console.log(`Evidence: ${evidence}`);
try {
  await ready.promise.finally(() => clearTimeout(startupDeadline));
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Auth HTTP ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { access_token: string };
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "Enterprise acceptance",
      workspaceRoot: repo,
    }),
  });
  NodeAssert.ok(created.ok, `Project HTTP ${created.status}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok);
  const ticket = (await ticketResponse.json()) as { ticket: string };
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  const criterion = docs
    ? "GUIDE.md exactly matches REFERENCE.md limits; title/footer and all other files stay unchanged"
    : "add returns a+b for positive, negative and zero; only calc.py changes";
  const checkCodes = docs
    ? [
        `from pathlib import Path; assert Path('GUIDE.md').read_text()==${JSON.stringify(expected)}`,
        "from pathlib import Path; assert all('\\t' not in p.read_text() for p in Path('.').glob('*.md'))",
        "import ast; from pathlib import Path; [ast.parse(p.read_text()) for p in Path('.').glob('*.py')]",
        "from pathlib import Path; assert not any('sk-' in p.read_text() for p in Path('.').iterdir() if p.is_file())",
      ]
    : [
        "import unittest; r=unittest.TextTestRunner().run(unittest.defaultTestLoader.discover('.')); assert r.wasSuccessful()",
        "from pathlib import Path; assert '\\t' not in Path('calc.py').read_text()",
        "import ast; from pathlib import Path; ast.parse(Path('calc.py').read_text())",
        "from pathlib import Path; assert 'sk-' not in Path('calc.py').read_text()",
      ];
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const workflow = yield* decodeWorkflow({
      task: {
        taskId: `acceptance:${values.scenario}`,
        tenantId: "local",
        projectId,
        repoCommit: commit,
        acceptanceCriteria: [criterion],
        approvedTools: ["codex.workspace_read", "codex.workspace_write", "/usr/bin/python3"],
        budgetLimit: { currency: "USD" as const, limitCents: 500 },
      },
      repositoryRoot: repo,
      workspacesRoot: tasks,
      modelSelection: { instanceId: "codex", model: values.model! },
      plan: (["test", "lint", "typecheck", "security_scan"] as const).map((kind, i) => ({
        kind,
        name: kind,
        tool: "/usr/bin/python3",
        args: ["-B", "-c", checkCodes[i]!],
        timeoutMs: 10000,
      })),
      routing: {
        candidates: [
          { selection: { instanceId: "codex", model: values.model! }, tier: "cloud" as const },
          {
            selection: { instanceId: "codex", model: "ollama/qwen3-coder:30b" },
            tier: "local" as const,
          },
        ],
        preferLocalDocs: true,
        allowCloudFallback: false,
      },
    });
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
    const findRecord = (dir: string): string | undefined => {
      for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
        const p = NodePath.join(dir, entry.name);
        if (entry.name === "workflow-automation.json") return p;
        if (entry.isDirectory() && entry.name !== "checkout") {
          const found = findRecord(p);
          if (found) return found;
        }
      }
    };
    const recordPath = findRecord(tasks);
    NodeAssert.ok(recordPath);
    const input = yield* decodeAdvance(JSON.parse(NodeFS.readFileSync(recordPath, "utf8")).input);
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
        verdict = {
          passed: true,
          scenario: values.scenario,
          issueSource: "local gh fixture; no remote access",
          cloudModel: values.model,
          coderBackend: docs ? "ollama/qwen3-coder:30b" : values.model,
          stages,
          selections,
          verifiedCommit: state.draft.evidence.diffSha,
          remotePublication: "not attempted",
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
    serverExit: serverExit ?? null,
  };
  console.error(String(error));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  NodeFS.writeFileSync(NodePath.join(evidence, "verdict.json"), JSON.stringify(verdict, null, 2));
  // Startup pairing URLs are never printed. Disposable server state is removed after shutdown.
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") process.exitCode = 1;
    }
  }
  if (server.exitCode === null && server.signalCode === null)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (server.pid)
          try {
            process.kill(-server.pid, "SIGKILL");
          } catch {}
      }, 2000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
}

// Reap only the group created by this harness, including surviving provider children.
if (server.pid) {
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

NodeFS.rmSync(home, { recursive: true, force: true });
