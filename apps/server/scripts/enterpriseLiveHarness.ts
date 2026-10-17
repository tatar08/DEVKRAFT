// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side acceptance harness owns processes, transport and deadlines.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
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

/** Options shared by the opt-in live drills; scratch state never uses the installed T3 home. */
export interface LiveFixtureOptions {
  scratch: string;
  scenario: "docs" | "code";
  model: string;
  remote?: string | undefined;
  issue?: string | undefined;
}

/** Local fixtures reject GitHub writes; remote acceptance explicitly uses the installed GitHub CLI. */
export function createLiveFixture(values: LiveFixtureOptions, prefix = "t3-enterprise-live-") {
  const remote = values.remote;
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodePath.resolve(values.scratch), prefix));
  const home = NodePath.join(evidence, "home");
  const repo = NodePath.join(evidence, "repo");
  const tasks = NodePath.join(evidence, "tasks");
  const bin = NodePath.join(evidence, "bin");
  if (remote === undefined) NodeFS.mkdirSync(repo);
  else
    NodeChildProcess.execFileSync("git", ["clone", "-q", `https://github.com/${remote}.git`, repo]);
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
  const docs = values.scenario === "docs";
  const expected = "# Quickstart\n\nRetries: 2\nTimeout: 30 seconds\n\nPreserve this footer.\n";
  if (remote === undefined) git("init", "-q");
  if (remote === undefined)
    NodeFS.writeFileSync(
      NodePath.join(repo, "REFERENCE.md"),
      "# Service limits\n\nRetries: 2\nTimeout: 30 seconds\n",
    );
  if (remote === undefined)
    NodeFS.writeFileSync(
      NodePath.join(repo, "GUIDE.md"),
      "# Quickstart\n\nRetries: 9\nTimeout: 10 seconds\n\nPreserve this footer.\n",
    );
  if (remote === undefined)
    NodeFS.writeFileSync(NodePath.join(repo, "calc.py"), "def add(a, b):\n    return a - b\n");
  if (remote === undefined)
    NodeFS.writeFileSync(
      NodePath.join(repo, "test_calc.py"),
      "import unittest\nfrom calc import add\nclass Addition(unittest.TestCase):\n    def test_positive(self): self.assertEqual(add(4, 2), 6)\n    def test_negative(self): self.assertEqual(add(-4, -2), -6)\n    def test_zero(self): self.assertEqual(add(3, 0), 3)\n",
    );
  if (remote === undefined) {
    git("add", ".");
    git("commit", "-qm", "acceptance baseline");
  }
  const commit = git("rev-parse", "HEAD");
  const issue = {
    number: 1,
    title: docs ? "Synchronize quickstart limits" : "Correct calculator addition",
    body: docs
      ? "Fix GUIDE.md retry count and timeout to match REFERENCE.md. Preserve every other byte. Only change GUIDE.md."
      : "Fix calc.py add(a,b) to return the sum. Positive, negative and zero inputs must pass test_calc.py. Only change calc.py.",
    url:
      remote === undefined
        ? "https://github.com/local-fixture/enterprise-acceptance/issues/1"
        : `https://github.com/${remote}/issues/${values.issue}`,
  };
  // Local mode: the fake executable only implements issue reads; every other GitHub command fails
  // closed. Remote mode uses the installed, authenticated `gh` for the real issue and PR.
  if (remote === undefined)
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
  return { root, evidence, home, repo, tasks, bin, git, docs, expected, commit, issue, values };
}

/** Each start uses a fresh bootstrap credential, including restarts against the same home. */
export async function startLiveServer(
  fixture: ReturnType<typeof createLiveFixture>,
  mode: "source" | "dist",
) {
  const { root, home, bin } = fixture;
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
    [
      mode === "source" ? "apps/server/src/bin.ts" : "apps/server/dist/bin.mjs",
      "start",
      "--bootstrap-fd",
      "3",
      "--log-level",
      "debug",
    ],
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
  const startupDeadline = setTimeout(() => ready.reject(new Error("Startup timed out")), 30000);
  return {
    server,
    ready: ready.promise.finally(() => clearTimeout(startupDeadline)),
    interrupt: (error: Error) => ready.reject(error),
    exit: () => serverExit,
    connect: async () => {
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
      return {
        protocol,
        createProject: async (repo: string) => {
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
          return projectId;
        },
      };
    },
  };
}

/** Only signal the detached group whose PID this harness captured at spawn. */
export async function stopLiveServer(
  server: NodeChildProcess.ChildProcess,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
) {
  if (!server.pid) return;
  const kill = (signal: NodeJS.Signals) => {
    if (!server.pid) return;
    try {
      process.kill(-server.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const exited =
    server.exitCode !== null || server.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => server.once("exit", () => resolve()));
  kill(signal);
  const timer = setTimeout(() => kill("SIGKILL"), 2000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    kill("SIGKILL");
  }
}

/** Keeps both acceptance drivers on the same fixture, pricing and role-routing policy. */
export function makeLiveWorkflow(
  fixture: ReturnType<typeof createLiveFixture>,
  projectId: ProjectId,
  taskId = `acceptance:${fixture.values.scenario}`,
) {
  const { docs, expected, values, repo, tasks, commit } = fixture;
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
  return Effect.gen(function* () {
    const workflow = yield* decodeWorkflow({
      task: {
        taskId,
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
    return workflow;
  });
}

/** Reads the server-owned imported context after automation is explicitly stopped. */
export function readLiveAdvanceInput(tasks: string) {
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
  return decodeAdvance(JSON.parse(NodeFS.readFileSync(recordPath, "utf8")).input);
}
