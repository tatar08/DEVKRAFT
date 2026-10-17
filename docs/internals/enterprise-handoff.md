# Enterprise MVP: supervised handoff (Codex and Gemini)

> **สรุป:** ไฟล์นี้คือคำสั่งงานสำหรับ Codex และ Gemini ภายใต้การควบคุมของ Claude (supervisor). ทำเฉพาะงานที่ได้รับมอบหมาย ในไฟล์ที่ระบุ บน branch ของตัวเอง แล้วส่งรายงานตามแบบฟอร์มด้านล่าง ห้าม merge เอง

- **Base branch:** `enterprise/mvp` (rebase onto its latest head before starting; tenant boundary landed 17 October 2026)
- **Spec:** [`docs/T3_Code_Enterprise_Blueprint_v3_MVP.md`](../T3_Code_Enterprise_Blueprint_v3_MVP.md), in particular the _Core Clean Code & Organization Mandate_ and [the supervised review record](../T3_Code_Enterprise_Blueprint_v3_MVP.md#supervised-review-2026-10-17)
- **Repository rules:** [`AGENTS.md`](../../AGENTS.md) applies in full (Effect idioms, verifying rules, no repo-wide checks)

## 1. What the review found and what is already fixed

The baseline commit `c9d456ad42` is the previously uncommitted Codex/Gemini work. Focused tests, typecheck and lint passed, but the review found these problems. Do not re-introduce any of them.

| #   | Finding                                                                                                                                                                                       | Status                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `publishPullRequest` called `workflow.advance()`, so a publish could launch, retry or stop provider work and re-run corrections. Workflow errors were reported as `remote_failed`.            | Fixed: `EnterpriseWorkflowService.verify` (read-only)                       |
| 2   | Right after `gh pr create`, a lagging GitHub listing produced `publication_unknown`. The receipt flag was always `true`. The PR title used `slice(14, 26)`.                                   | Fixed                                                                       |
| 3   | `RuntimePolicy.resolve` spawned `codex --version` and `codex mcp list` on every resolve.                                                                                                      | Fixed: shared probe in `EnterpriseCodexSupport.ts`, success cached 1 minute |
| 4   | Core `orchestration-v2` imported `enterprise/`, and the role-thread regex was hard-coded in core.                                                                                             | Fixed: `RuntimePolicyRefinement` hook + `enterprise/runtimeLayer.ts`        |
| 5   | The 14 RPC names were copied 3×, `"ollama/"` + `slice(7)` 15×, the thread-ID template 4×, and error mapping roughly 7×.                                                                       | Fixed: `ENTERPRISE_WS_METHODS`, `CodexNamedProfile.ts`, `EnterpriseRun.ts`  |
| 6   | Duck typing on `unknown` in `ThreadManagementService`.                                                                                                                                        | Fixed: `Predicate` (same idiom as `orchestration-v2/http.ts`)               |
| 7   | `.t3-data/` (1.9 GB user data) sat untracked in the repo.                                                                                                                                     | Fixed: added to `.gitignore`                                                |
| 8   | God functions: `EnterpriseWorkspaceService.mutate` (~600 lines) and `EnterpriseRoleService` (~880 lines). RoleService was split in G1 (284 lines); WorkspaceService in C1 (1044 → 284 lines). | Fixed (G1, C1)                                                              |
| 9   | Implementation-level JSDoc and rationale comments are missing. Public interfaces now have JSDoc.                                                                                              | **Open → part of C1/G1**                                                    |
| 10  | `tenantId` was not an authorization boundary.                                                                                                                                                 | Fixed: ADR-003 environment-level allowlist (`EnterpriseTenancy`)            |

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
   npx vp test run apps/server/src/enterprise apps/server/src/cli/enterprise.test.ts packages/contracts/src/enterprise.test.ts apps/server/src/auth/RpcAuthorization.test.ts apps/server/src/orchestration-v2/RuntimePolicy.test.ts apps/server/src/orchestration-v2/ThreadManagementService.test.ts apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.test.ts
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

### Codex — C1: split `EnterpriseWorkspaceService.mutate` — ✅ done by Codex, reviewed and merged (commit `2a03a662cc`)

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

### Codex — C2: Phase 4 crash drill for held locks — ✅ done by Codex, reviewed and merged

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

### Gemini — G2: bound the automation dedupe map — closed (not needed, see decisions below)

**Files you may edit:** `apps/server/src/enterprise/EnterpriseWorkflowAutomation.ts`, plus new tests.

**Problem (corrected by supervisor review):** `sweep` already removes `seen` entries whose Architect thread left the active shell. The only leftover is a stopped workflow whose threads stay active. This task is low value; do it only after G1 is accepted.

**Do:** delete an entry when a workflow stops (ready, blocked, error or cancelled) or is no longer registered. Add a focused test that the map does not keep stopped tasks. Behavior must not change otherwise.

### Codex — C3: Phase 4 prompt-injection fixture suite (priority: high)

**Files you may edit:** new test files under `apps/server/src/enterprise/` only, for example `EnterprisePromptInjection.test.ts`. Do **not** edit production code or existing tests.

**Goal:** this is the Blueprint Phase 4 item "Prompt Injection Defense". It needs a corpus of adversarial fixtures proving that untrusted issue, repository and model text cannot raise privileges.

**Do:** write behavioral tests (no snapshots of implementation details) for each boundary:

1. **Issue import** (`EnterpriseIssueService`, fake `gh`): an issue body that impersonates a system or operator, claims tool grants or an approval, or contains secrets is stored as `trust: "untrusted_content"`, with secrets redacted and no change to the operator's TaskSpec.
2. **Prompt rendering** (`renderEnterpriseRolePrompt` in `EnterpriseRoleContext.ts`): hostile issue and predecessor text, including quotes, `}`, newlines and fake "instructions" headers, appears only inside the JSON-encoded untrusted fields. The fixed instruction prefix is unchanged and the JSON body still parses to the same fields.
3. **Role output** (`decodeEnterpriseRoleOutput`): model output that adds tool grants, spoofs an approval or QA verdict, uses path traversal or control-metadata paths (`.git`, `.codex`, `.agents`), adds extra fields, or leaks secrets (including JSON unicode escapes) is rejected.
4. **Runtime policy** (`EnterpriseRuntimePolicy`): a role thread asking for `full-access` or another provider still resolves to the named deny-by-default profile, or fails closed.

**Done when:** the new tests pass, the existing tests are unchanged and pass, and typecheck and lint are clean.

**If a defense gap is found:** do not fix it. Write a test that fails for that case, mark it with `it.fails` and the comment `// SECURITY GAP:`, and list the gap in your report.

### Codex — C4: Phase 4 restart drill script (priority: high)

**Files you may edit:**

- `apps/server/scripts/verify-enterprise-live.ts`
- new `apps/server/scripts/enterpriseLiveHarness.ts`
- new `apps/server/scripts/verify-enterprise-restart-drill.ts`

**Goal:** the Phase 4 exit drills for server restart and crash, built on the existing live harness. Your sandbox has no network and cannot run model turns, so the supervisor runs the drill live. Your job is to make it correct and typecheck clean.

**Do:**

1. Move the reusable parts of `verify-enterprise-live.ts` into `enterpriseLiveHarness.ts`: fixture repository, fake read-only `gh`, price file, server spawn plus "startup phase: complete" wait, bootstrap token exchange, project creation, WebSocket RPC layer, and kill of the process group. Keep `verify-enterprise-live.ts` behavior and CLI flags unchanged.
2. Add `verify-enterprise-restart-drill.ts`, which uses the local fixture only (no GitHub writes) and `--server source|dist`. It runs two scenarios against **one persistent T3 home**, restarting the server process each time and pairing a new session from a new bootstrap token after each restart:
   - **`between-stages`:** start the code workflow and wait until the Coder run is completed with a ready checkpoint. `SIGKILL` the server process group, restart it with the same home, then keep calling `enterprise.advanceWorkflow` until `ready`. **Assert:** exactly one run on each role thread whose `userMessageId` ends in `:initial`, no extra role threads, and the same verified commit after one more `advanceWorkflow`.
   - **`mid-turn`:** as soon as the Coder run is `running`, `SIGKILL` the process group and restart. **Assert:** the Coder run is not silently replayed; the workflow ends in `blocked` (`failed_run`), or in `running` with the same single run, but never with a second `:initial` run. Record which outcome happened.
3. Write `restart-drill-verdict.json` (scenario results, thread run counts, verified commits) into the scratch evidence directory, as `verify-enterprise-live.ts` does with its verdict.

**Done when:** typecheck and lint are clean, and `verify-enterprise-live.ts --help` style argument validation still works. Do not run model turns.

### Codex — C5: web Founder Cockpit (Phase 5, priority: high)

**Data layer (already built, do not change):**

- `enterpriseEnvironment` in `apps/web/src/state/enterprise.ts`, from `packages/client-runtime/src/state/enterprise.ts`:
  - `workOrders({ environmentId, input: {} })` is a read query refreshed every 5 seconds. Read it with `useEnvironmentQuery`.
  - `getApproval`, `recordApproval`, `mergeTask`, `checkMerge`, `publishPullRequest` and `cancelWorkflow` are commands. Call them with `useAtomCommand`, following the pattern in `components/settings/ScheduledTasksSettings.tsx`.
- Types are `EnterpriseWorkOrder`, `EnterpriseApprovalStatus` and the others in `packages/contracts/src/enterprise.ts`. Each work order carries the `workflow` input that the commands need.

**Files you may edit:**

- new `apps/web/src/routes/_chat.work-orders.tsx`
- new files under `apps/web/src/components/enterprise/`
- the regenerated `apps/web/src/routeTree.gen.ts`
- one nav entry in `apps/web/src/components/sidebar/SidebarChrome.tsx`, next to "/pull-requests", plus its location check in `apps/web/src/components/sidebar/mainAppLocation.ts`

Do not touch server, contracts or client-runtime code.

**Build:**

1. **Kanban board.** Columns, in order: Queued, Running, Verifying, Awaiting Approval, PR Opened, Blocked, based on `workOrder.stage`.
   - Each card shows the title, task ID, active role and revision when present, stored approval counts, a PR link when present and a relative `updatedAt`.
   - The board must be keyboard navigable: cards are focusable and Enter opens one.
   - Handle empty, loading, error, disconnected and partial states, like other pages do.
2. **Proof-of-Work detail panel.** It opens from a card and calls `getApproval` once when opened and when the user presses Refresh (never on a timer, because it re-runs the gate). It shows:
   - the verified commit, each check with its status, the security scan, the cost (or "unknown") against the budget
   - the risk tier, critical changes, matched rules, required versus counted approvers, ignored decisions with their reasons, and blockers
   - Use plain language for blockers such as `approval_required` and `stale_diff`.
3. **Actions.** Each action is disabled with a visible reason when it doesn't apply:
   - **Approve / Reject:** `recordApproval`. Rejecting asks for confirmation via `requestConfirmDialog`.
   - **Publish draft PR:** `publishPullRequest`. The user enters the repository (`OWNER/REPO`) and the base branch, which defaults to `main`.
   - **Check merge:** `checkMerge`, against a target branch the user enters.
   - **Merge:** `mergeTask`. Enabled only when `blockers` is empty. It needs `expectedTargetCommit`, taken from a fresh `checkMerge` result's `targetCommit`. It always asks for confirmation and states that it moves a local branch and never pushes.
   - **Cancel workflow:** `cancelWorkflow`, with confirmation.
   - **Open in T3:** links to the active Coder thread route (`/$environmentId/$threadId`), where the existing diff, terminal and **preview** panels work on the task checkout.
   - **Preview:** opens the existing preview for the Coder thread, via `components/preview/openPreviewSession.ts`. It runs only on an explicit click and never automatically, because a dev server runs on the host outside the check sandbox. Show that warning next to the button.
4. **Accessibility and design.** Follow the existing design system in `components/ui/*`, use semantic headings, visible focus states and touch targets of at least 44 px on narrow widths. Respect reduced-motion settings. Do not add new dependencies.

**Tests:** logic tests only, for example grouping, blocker wording and action enablement as pure functions in a `*.logic.ts` file. Do not render components to static markup (AGENTS.md).

**Done when:** typecheck passes for `apps/web` and lint is clean for the changed files. The supervisor verifies in a real client.

### Codex/Gemini — C6: mobile approval inbox (Phase 5, after C5)

Extend the existing React Native app in `apps/mobile`. Wire `createEnterpriseEnvironmentAtoms` into the mobile connection runtime, then add an "Approvals" screen:

- It lists work orders in `awaiting_approval` (read query).
- Opening one calls `getApproval` and shows the same Proof-of-Work summary as web, in compact form.
- Approve and Reject use `recordApproval`. A rejection asks for confirmation.
- Merge and Publish are **not** offered on mobile in the MVP.

Follow `apps/mobile` conventions (`features/`, themed list rows, safe areas). Touch targets must be at least 44 pt. Handle offline state: show the cached list read-only, and disable decisions while disconnected, because approval must never be acknowledged offline (Blueprint risk register).

### Decisions made jointly by Claude and Codex (17 October 2026, delegated by the user)

| Topic                                | Decision               | Reason                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-session tenant binding           | **Deferred**           | The MVP is single-operator. Session `subject` values are generic, not identities, so deriving tenants from them would give false assurance. When mutually untrusted users are in scope, issue an immutable server-side tenant claim at pairing, carry it through grant redemption into the session, and check it together with the ADR-003 allowlist. |
| Live GitHub PR acceptance            | **Deferred**           | The user's instruction "test locally, create nothing on GitHub" still stands. Remote publication and reconciliation remain an open acceptance gate.                                                                                                                                                                                                   |
| Pushing `enterprise/mvp`             | **Not pushed**         | `origin` is upstream `pingdotgg/t3code`. Push only on the user's request, to a verified remote for their own fork.                                                                                                                                                                                                                                    |
| Merged worktrees                     | **Removed**            | Each was checked for unique commits, changes, non-dependency ignored files and running processes. Branches are kept.                                                                                                                                                                                                                                  |
| G2 (bound the automation `seen` map) | **Closed, not needed** | The sweep already drops keys of inactive workflows. A cap or TTL could evict dedupe entries and repeat work.                                                                                                                                                                                                                                          |
| Risk found by Codex                  | **Fixed**              | Automation checked authorization only after the no-change shortcut, so a revoked workflow stayed "enabled". It is now re-authorized on every tick, with a regression test.                                                                                                                                                                            |

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
