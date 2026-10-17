// @effect-diagnostics nodeBuiltinImport:off - Real process exit and filesystem timestamps exercise crash recovery outside Effect finalization.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

const crashExitCode = 73;
const oldLockTimeSeconds = 946_684_800; // 2000-01-01, well before any publication attempt.

// Run the real publisher in a disposable process: process.exit bypasses its lock finalizer,
// unlike an Effect failure or interruption. Only git, gh, workflow and workspace are fakes.
const childProgram = `
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as Publication from ${JSON.stringify(new URL("./EnterprisePublicationService.ts", import.meta.url).href)};
import * as Git from ${JSON.stringify(new URL("../vcs/GitVcsDriver.ts", import.meta.url).href)};
import * as Runner from ${JSON.stringify(new URL("../processRunner.ts", import.meta.url).href)};
import * as Workflow from ${JSON.stringify(new URL("./EnterpriseWorkflowService.ts", import.meta.url).href)};
import * as Workspace from ${JSON.stringify(new URL("./EnterpriseWorkspaceService.ts", import.meta.url).href)};
const [root, mode] = process.argv.slice(1);
const sha = "a".repeat(40);
const workflow = {
  task: { taskId: "task:crash", tenantId: "local", projectId: "project:1",
    repoCommit: sha, acceptanceCriteria: ["fix"], approvedTools: [],
    budgetLimit: { currency: "USD", limitCents: 150 } },
  repositoryRoot: root + "/repo", workspacesRoot: root, issueContext: "fixture",
  modelSelection: { instanceId: "codex", model: "model" },
  plan: ["test", "lint", "typecheck", "security_scan"].map(kind => ({
    name: kind, kind, tool: "/usr/bin/true", args: [], timeoutMs: 1000 }))
};
const check = { name: "tests", kind: "test", status: "passed", commitSha: sha, artifactIds: ["gate"] };
const draft = { body: "Verified fixture", approvalStatus: "not_evaluated", evidence: {
  taskId: "task:crash", diffSha: sha, tests: [check],
  securityScan: { ...check, kind: "security_scan" }, cost: { currency: "USD", amountCents: 10 },
  provenance: { threadId: "thread:1", runId: "run:1", commitSha: sha, artifactIds: ["gate"] }
}};
const runner = { run: request => Effect.sync(() => {
  const operation = request.args[1];
  appendFileSync(root + "/gh.log", operation + "\\n");
  if (operation === "create") {
    if (mode !== "crash") throw new Error("retry must never create a PR");
    const receipt = JSON.parse(readFileSync(root + "/publication.json", "utf8"));
    if (receipt.commitSha !== sha || !existsSync(root + "/publication.lock"))
      throw new Error("crash must occur after receipt and lock are persisted");
    process.exit(${crashExitCode});
  }
  const head = request.args[request.args.indexOf("--head") + 1];
  const prs = mode === "found" ? [{ number: 7, url: "https://github.com/example/repo/pull/7",
    headRefName: head, headRefOid: sha, baseRefName: "main", isDraft: true,
    isCrossRepository: false, state: "OPEN" }] : [];
  return { stdout: JSON.stringify(prs), stderr: "", code: 0, timedOut: false,
    stdoutTruncated: false, stderrTruncated: false, stdoutInvalidUtf8: false, stderrInvalidUtf8: false };
}) };
const layer = Publication.layer.pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(Git.GitVcsDriver, { execute: request => Effect.succeed({
    exitCode: request.args.includes("config") ? 1 : 0, stdout: "", stderr: "",
    stdoutTruncated: false, stderrTruncated: false }) }),
  Layer.succeed(Runner.ProcessRunner, runner),
  Layer.succeed(Workspace.EnterpriseWorkspaceService, { prepare: () => Effect.succeed({ worktreePath: root + "/checkout" }) }),
  Layer.succeed(Workflow.EnterpriseWorkflowService, {
    verify: () => Effect.succeed({ state: "ready", revision: 0, draft }),
    advance: () => Effect.die("publication must not advance workflow") })
)));
const result = await Effect.runPromise(Effect.gen(function* () {
  const service = yield* Publication.EnterprisePublicationService;
  return yield* service.publish({ workflow, repository: "example/repo", baseBranch: "main" }).pipe(Effect.result);
}).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer)));
console.log(JSON.stringify(result));
`;

/** A fresh process models restart without sharing in-memory publication state. */
function publish(root: string, mode: "crash" | "missing" | "found") {
  const outputPath = NodePath.join(root, "child-output.log");
  const fd = NodeFS.openSync(outputPath, "w");
  try {
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      ["--input-type=module", "-e", childProgram, root, mode],
      { cwd: new URL("../../", import.meta.url), stdio: ["ignore", fd, fd] },
    );
    const output = NodeFS.readFileSync(outputPath, "utf8");
    assert.ifError(child.error);
    assert.equal(child.signal, null, output);
    assert.equal(child.status, mode === "crash" ? crashExitCode : 0, output);
    return output;
  } finally {
    NodeFS.closeSync(fd);
  }
}

describe("Enterprise publication held-lock crash drill", () => {
  it.each(["found", "missing"] as const)(
    "keeps an old crash lock busy and reconciles %s PRs after operator removal",
    async (recovery) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-publication-crash-"));
      try {
        await NodeFSP.mkdir(NodePath.join(root, "checkout"));
        publish(root, "crash");
        const receipt = await NodeFSP.readFile(NodePath.join(root, "publication.json"), "utf8");
        const lock = NodePath.join(root, "publication.lock");
        assert.isTrue((await NodeFSP.stat(lock)).isDirectory());
        const calls = await NodeFSP.readFile(NodePath.join(root, "gh.log"), "utf8");
        assert.equal(calls, "list\ncreate\n");

        // An arbitrarily old mtime must never authorize reclaiming a held lock.
        await NodeFSP.utimes(lock, oldLockTimeSeconds, oldLockTimeSeconds);
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.include(publish(root, recovery), '"reason":"busy"');
          assert.equal((await NodeFSP.stat(lock)).mtimeMs, oldLockTimeSeconds * 1000);
          assert.equal(await NodeFSP.readFile(NodePath.join(root, "gh.log"), "utf8"), calls);
        }

        // Only the operator removes the lock; preserve the receipt across every retry.
        await NodeFSP.rm(lock, { recursive: true });
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = publish(root, recovery);
          if (recovery === "found") {
            assert.include(result, '"_tag":"Success"');
            assert.include(result, '"reconciled":true');
            assert.include(result, '"url":"https://github.com/example/repo/pull/7"');
          } else {
            assert.include(result, '"reason":"publication_unknown"');
          }
          // The intent fields never change; a reconciled retry only adds the settled PR.
          const current = JSON.parse(
            await NodeFSP.readFile(NodePath.join(root, "publication.json"), "utf8"),
          ) as Record<string, unknown>;
          const { pullRequest, ...intent } = current;
          assert.deepEqual(intent, JSON.parse(receipt));
          if (recovery === "found")
            assert.deepEqual(pullRequest, {
              url: "https://github.com/example/repo/pull/7",
              number: 7,
            });
          else assert.isUndefined(pullRequest);
        }
        assert.equal(
          await NodeFSP.readFile(NodePath.join(root, "gh.log"), "utf8"),
          calls + "list\nlist\n",
        );
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
