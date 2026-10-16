# Enterprise MVP: supervised handoff (Codex and Gemini)

> **สรุป:** ไฟล์นี้คือคำสั่งงานสำหรับ Codex และ Gemini ภายใต้การควบคุมของ Claude (supervisor). ทำเฉพาะงานที่ได้รับมอบหมาย ในไฟล์ที่ระบุ บน branch ของตัวเอง แล้วส่งรายงานตามแบบฟอร์มด้านล่าง ห้าม merge เอง

- **Base branch:** `enterprise/mvp` (rebase onto its latest head before starting; tenant boundary landed 17 October 2026)
- **Spec:** [`docs/T3_Code_Enterprise_Blueprint_v3_MVP.md`](../T3_Code_Enterprise_Blueprint_v3_MVP.md), in particular the _Core Clean Code & Organization Mandate_ and [the supervised review record](../T3_Code_Enterprise_Blueprint_v3_MVP.md#supervised-review-2026-10-17)
- **Repository rules:** [`AGENTS.md`](../../AGENTS.md) applies in full (Effect idioms, verifying rules, no repo-wide checks)

## 1. What the review found and what is already fixed

The baseline commit `c9d456ad42` is the previously uncommitted Codex/Gemini work. Focused tests, typecheck and lint passed, but the review found these problems. Do not re-introduce any of them.

| #   | Finding                                                                                                                                                                            | Status                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `publishPullRequest` called `workflow.advance()`, so a publish could launch, retry or stop provider work and re-run corrections. Workflow errors were reported as `remote_failed`. | Fixed: `EnterpriseWorkflowService.verify` (read-only)                       |
| 2   | Right after `gh pr create`, a lagging GitHub listing produced `publication_unknown`. The receipt flag was always `true`. The PR title used `slice(14, 26)`.                        | Fixed                                                                       |
| 3   | `RuntimePolicy.resolve` spawned `codex --version` and `codex mcp list` on every resolve.                                                                                           | Fixed: shared probe in `EnterpriseCodexSupport.ts`, success cached 1 minute |
| 4   | Core `orchestration-v2` imported `enterprise/`, and the role-thread regex was hard-coded in core.                                                                                  | Fixed: `RuntimePolicyRefinement` hook + `enterprise/runtimeLayer.ts`        |
| 5   | The 14 RPC names were copied 3×, `"ollama/"` + `slice(7)` 15×, the thread-ID template 4×, and error mapping roughly 7×.                                                            | Fixed: `ENTERPRISE_WS_METHODS`, `CodexNamedProfile.ts`, `EnterpriseRun.ts`  |
| 6   | Duck typing on `unknown` in `ThreadManagementService`.                                                                                                                             | Fixed: `Predicate` (same idiom as `orchestration-v2/http.ts`)               |
| 7   | `.t3-data/` (1.9 GB user data) sat untracked in the repo.                                                                                                                          | Fixed: added to `.gitignore`                                                |
| 8   | God functions: `EnterpriseWorkspaceService.mutate` (~600 lines) and `EnterpriseRoleService` (~880 lines). RoleService was split in G1 (284 lines).                                 | **Open → C1** (G1 done)                                                     |
| 9   | Implementation-level JSDoc and rationale comments are missing. Public interfaces now have JSDoc.                                                                                   | **Open → part of C1/G1**                                                    |
| 10  | `tenantId` was not an authorization boundary.                                                                                                                                      | Fixed: ADR-003 environment-level allowlist (`EnterpriseTenancy`)            |

Checked and found not to be a problem: Node runs inside the real sandbox under `prlimit --as=2GiB`. Probing `codex` from PATH is correct, because `isDefaultEnterpriseCodexConfig` requires `binaryPath === "codex"`.

## 2. Rules of engagement (both agents)

1. **One task, one branch, one worktree.** Branch off `enterprise/mvp` as `enterprise/<agent>-<task>`, for example `enterprise/codex-c1`. Work in `git worktree add ../t3-<agent>-<task> -b enterprise/<agent>-<task> enterprise/mvp`. Never commit to `enterprise/mvp` or `main`.
2. **Stay inside your file list.** The lists in section 3 are disjoint so Codex and Gemini never edit the same file. If you need a file outside your list, stop and report instead of editing it.
3. **Refactors change no behavior.** Do not edit existing tests to make them pass. A refactor is done when the existing tests pass unchanged. New tests are welcome.
4. **Keep these invariants.** Do not weaken any of them:
   - The system fails closed: an unknown provider, version, host layout or state is rejected, never assumed safe.
   - No new ledger, outbox, database or provider execution pipeline. V2 stays the source of progress (ADR-001).
   - Core `apps/server/src/orchestration-v2/**` must not import `apps/server/src/enterprise/**`. The only exception is the composition root `runtimeLayer.ts`, which imports `enterprise/runtimeLayer.ts`.
   - Nothing auto-merges or auto-publishes. `approvalStatus` stays `"not_evaluated"` until Phase 4/5 approval exists.
   - Never put secrets, tokens or real `~/.t3` data in tests or fixtures. Use temp directories.
5. **Write code in the style of what surrounds it:**
   - Effect idioms: `Effect.fn`, `yield*` of a yieldable error, `Schema` decoders.
   - JSDoc on exported symbols that explains _why_.
   - No `any`, `as unknown as` or `@ts-ignore` in non-test code.
   - Name magic numbers.
6. **Verify (smallest proof, as `AGENTS.md` requires).** Run from the repo root:
   ```bash
   npx vp test run apps/server/src/enterprise apps/server/src/cli/enterprise.test.ts packages/contracts/src/enterprise.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/orchestration-v2/RuntimePolicy.test.ts
   ```
   ```bash
   cd apps/server && npx tsc-rs --noEmit
   ```
   ```bash
   npx vp lint <changed files>
   ```
   The baseline is **579 passed, 5 skipped, 0 failed**. Lint warnings that already exist upstream (unused `Fiber`/`Schedule` in `ws.ts`, the empty import in `rpc.ts`) are not yours.
7. **Commits.** Use conventional commits (`refactor(enterprise): …`). Make small commits, each of which passes the tests. Do not push and do not open PRs; the supervisor merges.
   - **Sandboxed agents (Codex `workspace-write`):** the repository `.git` metadata is read-only. Do not rebase or commit; the supervisor prepares the worktree and commits your reviewed changes. Leave your changes uncommitted in the worktree.
8. **When blocked or rate-limited**, commit your work in progress with `wip:` in the subject, fill in the report, and stop. Do not leave uncommitted changes behind.

## 3. Assignments

### Codex — C1: split `EnterpriseWorkspaceService.mutate` (priority: high)

**Files you may edit:**

- `apps/server/src/enterprise/EnterpriseWorkspaceService.ts`
- new `apps/server/src/enterprise/EnterpriseWorkspace*.ts` files
- `apps/server/src/enterprise/EnterpriseWorkspaceService.test.ts` (only to add tests)

**Problem:** `mutate(input, operation)` takes a union of 10+ operation shapes (`"prepare" | "cleanup" | check | check[] | {type: …}`) and branches on them inside one ~600-line generator.

**Do:**

1. Move the artifact and record schemas plus their encoders/decoders (file lines 27–111: Ownership, Check/Snapshot/Failure artifacts, automation record) to `EnterpriseWorkspaceArtifacts.ts`.
2. Extract one shared helper, `withOwnership(input, (ctx) => …)`. Its **first** step must stay `tenancy.authorize(spec.tenantId)`, before any filesystem effect, and the tests "refuses an unlisted tenant…" and "keeps tenants … separate" must keep passing. It owns the resolve, validate-manifest and acquire/release-operation-lock sequence that every operation repeats today.
3. Give each operation its own named function: `prepare`, `cleanup`, `runCheck(s)`, `gateSnapshot`, `readAutomation`, `writeAutomation`, `bindWorkflow`, `bindThread`, `releaseBindings`. Each takes typed input, not a union. Then delete `mutate` and `invoke`.
4. Write a JSDoc rationale for every non-obvious guard: why ignored files block cleanup, why there is no age-based lock reclaim, why the `.codex`/`.agents` directories are created.

**Done when:**

- The public `EnterpriseWorkspaceService` interface is unchanged.
- No function body exceeds about 120 lines.
- The test baseline passes with the existing tests unchanged.
- `EnterpriseWorkspaceService.ts` is under 450 lines.

### Codex — C2: Phase 4 crash drill for held locks (priority: medium, after C1)

**Files you may edit:** `apps/server/src/enterprise/EnterprisePublicationService.ts`, plus new test files under `apps/server/src/enterprise/`.

**Do:**

1. Add a real-filesystem test that simulates a crash after `publication.json` is written and before `gh pr create` returns. The test must leave `publication.lock` on disk.
2. Assert that the next `publish` returns `busy`, never reclaims the lock by age, and never calls `gh pr create`.
3. Assert that after an operator removes the lock, the retry reconciles: it finds the PR, or returns `publication_unknown` and never creates a second PR.
4. Document the manual recovery steps in the JSDoc of `publish`.

**Done when:** the new tests pass with no sleeps or polling (use deterministic fakes for `gh`), the existing tests pass, and the code behaves exactly as before.

### Gemini — G1: split `EnterpriseRoleService` — ✅ done by the supervisor (commit `189234a407`)

**Files you may edit:**

- `apps/server/src/enterprise/EnterpriseRoleService.ts`
- new `apps/server/src/enterprise/EnterpriseRole*.ts` files

Do **not** edit `EnterpriseRoleService.test.ts`.

**Do:**

1. Move `validateModel`, including the local Ollama `/api/show` capability probe, to `EnterpriseRoleModel.ts`.
2. Move the construction of untrusted context for predecessor roles (Architect spec → Coder, QA findings → Coder, Coder diff → QA, and `encodeContext`) to `EnterpriseRoleContext.ts`.
3. Move gate, handoff and draft assembly (`collectHandoff`, `gateRole`, `gateAndContinue`, `buildPullRequestDraft`) into one or more cohesive modules. The service file should only compose them.
4. Add rationale JSDoc where a check exists for security reasons: tree equality between checkpoints, the 64 KiB diff cap, refusing cloud-backed Ollama models.

**Done when:**

- The `EnterpriseRoleService` interface and the layer type are unchanged.
- `EnterpriseRoleService.ts` is under 300 lines.
- No function exceeds about 120 lines.
- The test baseline passes with `EnterpriseRoleService.test.ts` unchanged.

### Gemini — G2: bound the automation dedupe map (priority: low)

**Files you may edit:** `apps/server/src/enterprise/EnterpriseWorkflowAutomation.ts`, plus new tests.

**Problem (corrected by supervisor review):** `sweep` already removes `seen` entries whose Architect thread left the active shell. The only leftover is a stopped workflow whose threads stay active. This task is low value; do it only after G1 is accepted.

**Do:** delete an entry when a workflow stops (ready, blocked, error or cancelled) or is no longer registered. Add a focused test that the map does not keep stopped tasks. Behavior must not change otherwise.

### Not assigned: needs a decision from the user first

- **Per-session tenant binding.** The environment-level boundary (ADR-003) is in place. Binding tenants to authenticated users needs a pairing-level claim and a design review.
- **Live remote acceptance (Phase 2).** The user deferred creating a real GitHub repository or PR on 17 October 2026.
- **Approval persistence (Phase 4/5).** This needs a design review before any code.

## 4. Report template (paste into the hand-back message)

```text
Agent / task: <Codex C1 | Codex C2 | Gemini G1 | Gemini G2>
Branch / head commit: enterprise/<agent>-<task> @ <sha>
Files changed: <list>   (confirm: all inside the assigned list? yes/no)
Behavior change: none | <describe, with test that proves it>
Verification:
  tests: <N passed / M skipped / F failed> (command used)
  typecheck: pass/fail
  lint: <new warnings or "none">
Line counts after: <file: lines>
Open questions / risks:
Anything you could NOT finish:
```

## 5. Supervisor review checklist (used to accept or reject a hand-back)

- [ ] The diff touches only the assigned files, and no existing test was modified (except where the task allows adding tests).
- [ ] I re-ran the tests myself on the branch and matched or exceeded the baseline.
- [ ] No new `any`/casts, no imports from core into `enterprise/` that go the wrong way, and no fail-open path.
- [ ] Every new function has a clear single responsibility, and JSDoc explains intent.
- [ ] The Blueprint status is still truthful. Update it in the same merge when scope changes.
