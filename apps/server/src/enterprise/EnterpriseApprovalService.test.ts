import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnterpriseAdvanceWorkflowInput,
  EnterprisePullRequestDraft,
  type EnterpriseAdvanceWorkflowResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Approvals from "./EnterpriseApprovalService.ts";
import * as Workflows from "./EnterpriseWorkflowService.ts";
import * as Workspace from "./EnterpriseWorkspaceService.ts";

const decodeWorkflow = Schema.decodeUnknownSync(EnterpriseAdvanceWorkflowInput);
const decodeDraft = Schema.decodeUnknownSync(EnterprisePullRequestDraft);
const alice = { sessionId: AuthSessionId.make("session:alice"), subject: "desktop-bootstrap" };
const bob = { sessionId: AuthSessionId.make("session:bob"), subject: "one-time-token" };

/**
 * Real Git, WorkspaceService and MergeService. Only the V2 workflow and the auth session store are
 * fakes, so revalidation can be driven: a new verified commit, a revoked session, a moved clock.
 */
const setup = (options: { readonly taskFile?: string } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* Git.GitVcsDriver;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-approval-" });
    const repositoryRoot = `${temp}/repo`;
    yield* fs.makeDirectory(repositoryRoot);
    const run = (cwd: string, args: ReadonlyArray<string>) =>
      git.execute({
        operation: "EnterpriseApproval.test",
        cwd,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      });
    yield* run(repositoryRoot, ["init", "-b", "main"]);
    yield* fs.writeFileString(`${repositoryRoot}/calc.py`, "def add(a, b):\n    return a - b\n");
    yield* run(repositoryRoot, ["add", "."]);
    yield* run(repositoryRoot, ["commit", "-m", "base"]);
    const base = (yield* run(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    // Merging needs `main` not checked out anywhere, as in a real review flow.
    yield* run(repositoryRoot, ["checkout", "--detach"]);
    const workflow = decodeWorkflow({
      task: {
        taskId: "task:approval",
        tenantId: "local",
        projectId: "project:approval",
        repoCommit: base,
        acceptanceCriteria: ["add returns the sum"],
        approvedTools: ["codex.workspace_read", "codex.workspace_write", "/usr/bin/true"],
        budgetLimit: { currency: "USD", limitCents: 500 },
      },
      repositoryRoot,
      workspacesRoot: `${temp}/tasks`,
      modelSelection: { instanceId: "codex", model: "model" },
      issueContext: "untrusted",
      plan: ["test", "lint", "typecheck", "security_scan"].map((kind) => ({
        name: kind,
        kind,
        tool: "/usr/bin/true",
        args: [],
        timeoutMs: 1000,
      })),
    });
    const workspace = yield* Workspace.EnterpriseWorkspaceService;
    const owned = yield* workspace.prepare({
      spec: workflow.task,
      repositoryRoot,
      workspacesRoot: workflow.workspacesRoot,
    });
    const commitIn = (file: string, contents: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${owned.worktreePath}/${file}`, contents);
        yield* run(owned.worktreePath, ["add", file]);
        yield* run(owned.worktreePath, ["commit", "-m", `change ${file}`]);
        return (yield* run(owned.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      });
    let verifiedCommit = yield* commitIn(
      options.taskFile ?? "calc.py",
      "def add(a, b):\n    return a + b\n",
    );
    const draftFor = (commitSha: string) => {
      const check = (kind: string) => ({
        name: kind,
        kind,
        status: "passed",
        commitSha,
        artifactIds: ["gate-artifact"],
      });
      return decodeDraft({
        evidence: {
          taskId: "task:approval",
          diffSha: commitSha,
          tests: ["test", "lint", "typecheck"].map(check),
          securityScan: check("security_scan"),
          cost: { currency: "USD", amountCents: 15 },
          provenance: {
            threadId: "thread:coder",
            runId: "run:coder",
            commitSha,
            artifactIds: ["gate-artifact"],
          },
        },
        body: "Proof of work",
        approvalStatus: "not_evaluated",
      });
    };
    const revoked = new Set<string>();
    const sessions = Layer.mock(Sessions.AuthSessionRepository)({
      getById: ({ sessionId }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return Option.some({
            sessionId,
            revokedAt: revoked.has(sessionId) ? now : null,
            expiresAt: DateTime.add(now, { days: 30 }),
            scopes: ["orchestration:operate", "filesystem:write", "source-control:write"],
          } as unknown as Sessions.AuthSessionRecord);
        }),
    });
    const workflows = Layer.succeed(Workflows.EnterpriseWorkflowService, {
      advance: () => Effect.die("approvals must not advance the workflow"),
      verify: () =>
        Effect.sync((): EnterpriseAdvanceWorkflowResult => ({
          state: "ready",
          revision: 0,
          draft: draftFor(verifiedCommit),
        })),
    });
    const service = yield* Approvals.EnterpriseApprovalService.pipe(
      Effect.provide(
        Approvals.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              sessions,
              workflows,
              Layer.succeed(Workspace.EnterpriseWorkspaceService, workspace),
            ),
          ),
        ),
      ),
    );
    return {
      service,
      workflow,
      base,
      run: (args: ReadonlyArray<string>) => run(repositoryRoot, args),
      revoke: (sessionId: string) => Effect.sync(() => revoked.add(sessionId)),
      newCommit: (contents: string) =>
        commitIn("calc.py", contents).pipe(
          Effect.tap((sha) => Effect.sync(() => (verifiedCommit = sha))),
        ),
      merge: (actor: Approvals.EnterpriseApprover, expectedTargetCommit = base) =>
        service.merge({ workflow, targetBranch: "main", expectedTargetCommit }, actor),
    };
  });

const testLayer = Workspace.layer.pipe(
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(NodeServices.layer),
);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(testLayer));
const approve = (validForMinutes?: number) => ({
  decision: "approve" as const,
  ...(validForMinutes === undefined ? {} : { validForMinutes }),
});

describe("EnterpriseApprovalService", () => {
  it.effect("blocks merging until an authenticated session approves, then merges by CAS", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        const pending = yield* env.service.status({ workflow: env.workflow });
        assert.equal(pending.risk.decision, "pending");
        assert.equal(pending.risk.tier, 1);
        assert.include(pending.blockers, "approval_required");
        const refused = yield* env.merge(alice).pipe(Effect.flip);
        assert.equal(refused.reason, "blocked");
        assert.equal((yield* env.run(["rev-parse", "main"])).stdout.trim(), env.base);

        const approved = yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        assert.equal(approved.risk.decision, "approved");
        assert.deepEqual(approved.risk.approvers, [alice.sessionId]);
        assert.deepEqual(approved.blockers, []);
        const merged = yield* env.merge(alice);
        assert.equal(merged.previousCommit, env.base);
        const parents = (yield* env.run(["rev-list", "--parents", "-n", "1", "main"])).stdout
          .trim()
          .split(" ");
        assert.deepEqual(parents.slice(1), [env.base, approved.evidence.diffSha]);
      }),
    ),
  );

  it.effect("stops counting an approval once its session is revoked", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        yield* env.revoke(alice.sessionId);
        const status = yield* env.service.status({ workflow: env.workflow });
        assert.equal(status.risk.decision, "pending");
        assert.deepEqual(status.ignored, [
          { sessionId: alice.sessionId, reason: "session_invalid" },
        ]);
        assert.equal((yield* env.merge(bob).pipe(Effect.flip)).reason, "blocked");
      }),
    ),
  );

  it.effect("does not carry an approval over to a newer verified commit", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        yield* env.newCommit("def add(a, b):\n    return b + a\n");
        const status = yield* env.service.status({ workflow: env.workflow });
        assert.equal(status.risk.decision, "pending");
        assert.equal(status.ignored[0]?.reason, "stale_diff");
      }),
    ),
  );

  it.effect("expires approvals by the server clock", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.record({ workflow: env.workflow, ...approve(5) }, alice);
        yield* TestClock.adjust("6 minutes");
        const status = yield* env.service.status({ workflow: env.workflow });
        assert.equal(status.risk.decision, "pending");
        assert.equal(status.ignored[0]?.reason, "expired");
      }),
    ),
  );

  it.effect("requires two distinct sessions for a critical change", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup({ taskFile: "requirements.txt" });
        const once = yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        assert.equal(once.risk.tier, 2);
        assert.include(once.risk.criticalChanges, "dependency_scripts");
        // Approving twice from one session replaces, never doubles, its vote.
        const twice = yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        assert.equal(twice.risk.decision, "pending");
        const both = yield* env.service.record({ workflow: env.workflow, ...approve() }, bob);
        assert.equal(both.risk.decision, "approved");
        assert.equal(both.risk.approvers.length, 2);
      }),
    ),
  );

  it.effect("lets a valid rejection win over approvals", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        const rejected = yield* env.service.record(
          { workflow: env.workflow, decision: "reject" },
          bob,
        );
        assert.equal(rejected.risk.decision, "rejected");
        assert.equal((yield* env.merge(alice).pipe(Effect.flip)).reason, "blocked");
      }),
    ),
  );

  it.effect("refuses approval or merge from a session that is no longer authorized", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.revoke(bob.sessionId);
        const recorded = yield* env.service
          .record({ workflow: env.workflow, ...approve() }, bob)
          .pipe(Effect.flip);
        assert.equal(recorded.reason, "authorization_required");
        assert.equal((yield* env.merge(bob).pipe(Effect.flip)).reason, "authorization_required");
      }),
    ),
  );

  it.effect("refuses to overwrite a target that moved since it was reviewed", () =>
    provide(
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.service.record({ workflow: env.workflow, ...approve() }, alice);
        const stale = yield* env.merge(alice, "f".repeat(40)).pipe(Effect.flip);
        assert.equal(stale.reason, "target_moved");
        assert.equal((yield* env.run(["rev-parse", "main"])).stdout.trim(), env.base);
      }),
    ),
  );
});
