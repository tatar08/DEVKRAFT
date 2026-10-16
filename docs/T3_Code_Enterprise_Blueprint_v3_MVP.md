# T3 Code Enterprise Blueprint & Roadmap v3.0 — MVP & GitHub Launch Edition

> **Document type:** Implementation blueprint (standalone Markdown implementation record).  
> **Date:** 15 October 2026  
> **Basis:** Earlier Interactive HTML v3.0 and the previous v2.0 roadmap; the HTML source is not present in this checkout.  
> **Status:** Phase 2–3 integration added with focused coverage; local Issue-fixture workflows and repeated scoped cloud/local benchmarks are now verified; live remote publication remains unexecuted by user choice. V2 baseline checked; Enterprise contracts and CLI evidence verification implemented. Owned worktree/cleanup and CLI issue import implemented; Linux check execution fails closed when sandbox is unavailable. V2 role launch, checkpoint handoff, structured spec/QA and snapshot gate/PR drafts are implemented with focused tests. Two supervised QA-backed correction rounds are implemented. `gateAndContinue` now starts bounded corrections from persisted deterministic failures. A V2-backed workflow advance RPC now coordinates stages and correction rounds. Opt-in background automation now uses the existing scheduler and V2 event sequences, with persisted configuration and session revalidation. Explicit cancellation persists intent before existing V2 Stop commands and retries partial dispatch. Native Issue-to-PR acceptance, hard-crash recovery drills and remote PR reconciliation remain incomplete.  
> **Repository:** https://github.com/pingdotgg/t3code  
> **Pinned Commit:** `511d20c6f20c2ed6ff787aba068d7d673e2949b9` (Tag: `v0.0.46-nightly.20261012.3035` / `t3@0.0.45`)  
> **Local Runtime:** http://localhost:3700/ (reported in earlier setup; not reverified by the source/test audit).  
> **Provider setup:** Earlier setup reports Claude Code, Codex, Antigravity, OpenCode and local Ollama; this audit does not verify live provider connectivity or native T3 Ollama support.

This `.md` file preserves the v3.0 sections and expands HTML-only interactive data (risk register, scope tabs, release gates, task checklist, and UX views) into readable static Markdown. The original interactive HTML is currently absent; use this Markdown for the implementation status and verification links.

**เส้นทางตรวจสอบ:** [Implementation evidence](#implementation-evidence) → [V2 implementation boundary](./orchestration-v2/README.md#current-implementation-and-phase-4-boundary) → [Phase 4 งานที่ยังขาด](#phase-4-v2-enterprise-recovery) → [Implementation map](#implementation-map).

อ่านสถานะโดยแยก **มี implementation**, **มี focused tests ผ่าน**, และ **Enterprise ยังเสนออยู่**; ลิงก์ไปยังไฟล์ test เป็นหลักฐานว่ามี coverage ไม่ใช่การรับรองว่า test ทุกชุดหรือ provider จริงผ่านแล้ว

---

● v3.0 / Revised & Risk-Aware

# Build a software factory, not another agent chat.

ต่อยอด **pingdotgg/t3code** เป็น Local-First Multi-Agent Engineering Workspace ที่รับ Issue → ทำ Spec → เขียนโค้ด → ทดสอบ → ประเมินความเสี่ยง → ส่ง Pull Request พร้อม Proof of Work, การคุมต้นทุน และ Founder Dashboard โดยไม่สร้างความสามารถเดิมของ T3 ซ้ำโดยไม่จำเป็น

Multi-Agent HandoffProof-of-Work PRGit Worktree + SandboxOllama + CloudRemote ApprovalOpen Source First

**North Star MVP:** ผู้ใช้รายใหม่สามารถรัน 1 Issue-to-PR demo บน repository ตัวอย่างได้สำเร็จ โดยเห็น Diff, Tests, Cost, Risk และ Approve ได้จากหน้าเดียว — ไม่อ้างว่าโค้ดจะถูกต้อง 100% และไม่ Auto-Merge ไปยัง production โดยปริยาย

> 💡 **Core Clean Code & Organization Mandate (มาตรฐานโค้ดสะอาดและเป็นระเบียบ):**  
> ทุกส่วนของโค้ดที่พัฒนาขึ้น (ทั้งสถาปัตยกรรมตัวระบบ T3 Code เอง และโค้ดที่ AI Agent สร้าง/แก้ไข) **ต้องสะอาด เป็นระเบียบ อ่านเข้าใจง่าย และดูแลรักษาง่าย (Clean, Tidy, Modular & Maintainable)**:
>
> - **Clean Architecture & Modularity:** แยกหน้าที่ชัดเจน (Single Responsibility), โค้ดกระชับ ไม่ซ้ำซ้อน (DRY), ไม่เขียนไฟล์หรือฟังก์ชันใหญ่เกินจำเป็น (หลีกเลี่ยง Spaghetti Code)
> - **Meaningful Comments & JSDoc:** ใส่ Comment และ JSDoc กำกับฟังก์ชัน, อินเทอร์เฟซ และลอจิกสำคัญ เพื่ออธิบาย _“ทำไมถึงทำแบบนี้ (Rationale / Intent)”_ ไม่เขียนคอมเมนต์รกรุงรังเกินจริง
> - **Strict Type Safety:** เขียน TypeScript แบบ Fully-typed ไร้ `any` ที่ไม่จำเป็น ยึดตาม Contracts และ Schemas
> - **Upstream Alignment & Consistency:** รักษาสไตล์การจัดวางโค้ด, ลินเตอร์, และโครงสร้างไดเรกทอรีให้สอดคล้องกับมาตรฐานของ Upstream T3 Code เสมอ

MVP product surfaces

3

Desktop/Web, mobile approvals, GitHub PR

Demo workflow

5

Spec → Code → QA → Gate → PR

Initial production pilot

14 weeks

Planning estimate, subject to team and audit

Critical launch blockers

4

Contracts, isolation, approvals, recovery

---

## 01.1 / Live Status & Engineering Task Checklist

ตารางสรุปสถานะการพัฒนาจริง (Actual Implementation Status) และรายการงานย่อย (Task Checklist) แยกตาม 7 เฟสของ Roadmap 14 สัปดาห์:

**อัปเดตล่าสุด: 17 October 2026** — baseline ที่บันทึกก่อนหน้านี้ครอบคลุม build, pairing, scoped tests และ live CLI turns; รอบปัจจุบันเพิ่ม issue-to-workflow RPC, explicit draft publication/reconciliation, workflow routing, bounded provider retries และ native Ollama ผ่าน Codex profile เดิม การมี implementation และ focused tests ไม่เท่ากับผ่าน live remote acceptance หรือพร้อม production

**วิธีอ่านความคืบหน้า:** Phase 0–1 นับตามขอบเขต local/Linux MVP ที่บันทึกไว้ Phase 2 ยังต้องทดสอบ issue → remote PR บน demo repository จริง Phase 3 ผ่าน repeated scoped benchmark cloud/local ชุดเดียวกันแล้ว (5 cases × 3 repetitions ต่อ backend); ผลนี้ไม่รับรองทุกชนิดงานหรือคุณภาพ production ส่วน Phase 4 ยังไม่ผ่าน authenticated approval และ hard-crash recovery gates

```
[Phase 0:100%] ████████████████████ (8/8; provider CLI smoke verified)
[Phase 1: 5/5 service-level] ████████████████░░░░ (merge execution is service-level only; no authenticated RPC/UI)
[Phase 2: In progress] Issue URL → persisted workflow → verified draft publication implemented; live remote acceptance pending
[Phase 3: Scoped MVP measured] Routing/bounded failover + native Ollama through Codex implemented; repeated five-case cloud/local comparison completed, with all failures retained; raw reports live outside the repository
[Phase 4:  0%] ░░░░░░░░░░░░░░░░░░░░ (V2 workflow/cancel retry implemented; approval/PR recovery pending)
[Phase 5:  0%] ░░░░░░░░░░░░░░░░░░░░ (Kanban Cockpit & Mobile Approval)
[Phase 6:  0%] ░░░░░░░░░░░░░░░░░░░░ (Beta Release & Open Source Launch)
```

| Phase       | Scope & Milestones                           | Target Window |                           Status                            | Key Deliverable                                                                                                                                                                                                                                                      |
| :---------- | :------------------------------------------- | :-----------: | :---------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase 0** | Technical Audit & Baseline Verification      |     W1–W2     |                 🟢 **100% Verified (8/8)**                  | Audit + ADR + temporary server/web/pairing and provider CLI turns verified                                                                                                                                                                                           |
| **Phase 1** | Safe Task Execution & Git Worktree Isolation |     W3–W4     |             🟢 **5/5 service-level; no RPC/UI**             | Ownership/cleanup, Linux check sandbox, secret guard implemented; evidence-gated CAS merge service implemented; no authenticated RPC/UI yet                                                                                                                          |
| **Phase 2** | Multi-Agent Issue-to-PR Golden Path          |     W5–W6     | 🟡 **Implementation integrated; remote acceptance pending** | [Contracts + CLI issue/evidence/worktree services](#initial-implementation-contracts-and-evidence-verification); role services implemented; five-stage baseline demo recorded; issue-start and explicit draft publication RPCs added; live remote acceptance pending |
| **Phase 3** | Hybrid Router & Native Ollama GPU Profile    |     W7–W8     |   🟡 **Scoped comparison measured; reports not in repo**    | Routing/cost/bounded same-backend failover wired; Ollama uses Codex agent loop and existing permission profile; repeated five-case cloud/local benchmark completed; local quality limitations recorded                                                               |
| **Phase 4** | Durability, Recovery & Security Hardening    |    W9–W10     |              🟡 **In Progress; 0/5 complete**               | [V2-backed automation/cancel retry](#workflow-cancellation) implemented; authenticated approval/remote PR recovery pending                                                                                                                                           |
| **Phase 5** | Founder Cockpit, Kanban & Mobile Approvals   |    W11–W12    |                       ⚪ **Pending**                        | Work Order Deck & Tiered Approval Gate                                                                                                                                                                                                                               |
| **Phase 6** | Beta Release & Open-Source Launch            |    W13–W14    |                       ⚪ **Pending**                        | Demo Video, Benchmark Suite & Public Beta                                                                                                                                                                                                                            |

<a id="supervised-review-2026-10-17"></a>

### 🔍 Supervised code review (17 October 2026)

ตรวจ branch `enterprise/mvp` (baseline commit `c9d456ad42` = งาน Codex/Gemini ที่ยังไม่เคย commit) เทียบกับ Clean Code mandate และ ADR-001; focused tests 567 passed, typecheck `apps/server`/`packages/contracts` ผ่าน, lint ไม่มี error ใหม่

แก้แล้วใน branch นี้:

- `enterprise.publishPullRequest` ใช้ `EnterpriseWorkflowService.verify` (ไม่ launch/retry/stop provider work) และ map workflow errors เป็น `workflow_not_ready`; หาก GitHub listing ยังตามไม่ทันหลัง create จะใช้ URL ที่ `gh` พิมพ์ออกมาตรงตัวเท่านั้น
- Core (`orchestration-v2`) ไม่ import `enterprise/` แล้ว: `RuntimePolicyRefinement` เป็น extension point ทั่วไป และ Enterprise wiring อยู่ที่ `enterprise/runtimeLayer.ts`
- Codex host probes (`--version`, `mcp list`, toolchain) ใช้ร่วมกันและ cache เฉพาะผลสำเร็จ 1 นาที แทนการ spawn ทุก policy resolve
- รายชื่อ Enterprise RPC มีที่เดียว (`ENTERPRISE_WS_METHODS`); thread identity และ `ollama/` prefix มี helper เดียว
- ตรวจแล้วว่า Node ทำงานใน sandbox จริงภายใต้ `prlimit --as=2GiB` (ข้อกังวลเดิมไม่เป็นปัญหา)

ยังค้าง (ดู [handoff](./internals/enterprise-handoff.md)): แยก `EnterpriseWorkspaceService.mutate` (~600 บรรทัด) และ `EnterpriseRoleService`, JSDoc ในส่วน implementation, tenant-scoped authorization, live remote acceptance และ Phase 4 drills

### 📋 Phase 0: Technical Audit & Architecture Decisions (Weeks 1–2) — 100% (8/8 verified)

- [x] **Clone upstream repository:** โคลน `https://github.com/pingdotgg/t3code` ลงในไดเรกทอรีทดสอบ (`t3code-upstream`)
- [x] **Audit Monorepo boundaries:** ตรวจสอบโครงสร้างจริง (`apps/server`, `apps/web`, `apps/desktop`, `apps/mobile`, `packages/contracts`)
- [x] **Pin stable commit hash:** ล็อก Commit `511d20c6f20c2ed6ff787aba068d7d673e2949b9` (Tag `v0.0.46-nightly.20261012.3035`)
- [x] **Launch & verify live web instance:** full build ผ่าน และ built server เสิร์ฟ HTML/assets สำเร็จจาก fresh T3 home ใน `/tmp`; เป็น HTTP smoke verification ไม่ใช่ browser/desktop/mobile UI certification
- [x] **Pairing protocol verification:** แลก startup credential เป็น authenticated browser session สำเร็จ และ token เดิมถูกปฏิเสธเมื่อใช้ซ้ำ; ไม่บันทึก credential หรือใช้ live `~/.t3/userdata` ในการทดสอบ
- [x] **Verify local AI providers (live CLI connectivity, 17 October 2026):** model turn จริง (prompt `Reply with exactly: PONG`, ตอบ `PONG` ทุกตัว) ผ่านบน Codex `0.162.1`, Claude Code `2.1.301`, OpenCode `1.19.0` (โมเดล local `qwen3.6:35b-a3b` ผ่าน Ollama ไม่มี cloud credential) และ Ollama `0.40.4` daemon (`llama3:latest` ที่ `localhost:11434`); เป็น CLI/HTTP smoke ตรง ไม่ผ่าน T3 provider adapter, ไม่ได้ทดสอบ Antigravity และ native T3 Ollama adapter ยังอยู่ Phase 3
- [x] **ADR-001:** [Extend the local server and preserve V2](./internals/enterprise-boundaries.md#adr-001-extend-the-local-server-and-preserve-v2); ไม่สร้าง event ledger/outbox/provider orchestration ซ้ำ
- [x] **ADR-002:** [Execution threat model and fail-closed checks](./internals/enterprise-boundaries.md#adr-002-execution-threat-model-and-fail-closed-checks); จัดทำ decisions/threat model แล้ว ยังไม่ใช่ independent security sign-off

**Build verification:** full server/web build (`vp run --filter t3 build`) ผ่านหลังเปิด network ให้ license-notice fetch ตามขั้นตอนเดิม ไม่ข้าม license generation; server bundle build ล่าสุดหลังเพิ่ม role RPC/profile ผ่านแล้ว

### 📋 Phase 1: Safe Task Execution & Git Worktree Isolation (Weeks 3–4) — 5/5 service-level

**ฐานเดิมที่มีแล้ว:** [GitVcsDriverCore](../apps/server/src/vcs/GitVcsDriverCore.ts) มี create/remove worktree และ [WorktreeMcpService](../apps/server/src/mcp/WorktreeMcpService.ts) มี thread-worktree handoff พร้อม [tests](../apps/server/src/mcp/WorktreeMcpService.test.ts) การมีฐานนี้ไม่เท่ากับมี Enterprise per-task execution isolation; [EnterpriseWorkspaceService](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts) ต่อยอดฐานนี้ด้วย immutable ownership manifest และ operation lock; manifest เป็น resource record ไม่ใช่ ledger ของ agent runs

- [x] **Task Worktree Ownership (local CLI):** [service](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts) + [real-Git tests](../apps/server/src/enterprise/EnterpriseWorkspaceService.test.ts) แยก tenant/project/task, pinned commit, persisted spec และ exclusive lock; retry ใช้ manifest เดิมและไม่ adopt orphan checkout
- [x] **Safe Task Worktree Cleanup:** ปฏิเสธ held lock, ownership/branch/common-directory mismatch, dirty/ignored files และ commits ใหม่ ไม่ force remove และเก็บ branch; binding กับ V2 thread ถูกบันทึกก่อน launch จึงปิด cleanup เมื่อ launch ล้มเหลวหรือผลไม่แน่นอน การ release ต้องยืนยัน deleted threads, terminal runs และ stopped provider sessions จาก V2 ก่อน และ retire task เพื่อไม่ relaunch identity เดิม; scheduled GC ยังไม่ทำ
- [x] **Execution Sandboxing (Linux MVP):** [Bubblewrap + prlimit](../apps/server/src/enterprise/EnterpriseSandboxService.ts) ผ่าน real temporary-fixture checks: ซ่อน host home, ไม่ส่ง secret environment, ปิด network, fail closed และไม่สร้าง passing artifact เมื่อ check ล้มเหลว วาง process limits **ภายใน namespace** เพื่อไม่นับ threads บน host; [Codex runtime policy](../apps/server/src/enterprise/EnterpriseRuntimePolicy.ts) (via the core `RuntimePolicyRefinement` hook) ใช้ named deny-by-default profile, native profile probe ผ่านและ adapter `thread/start` เลือก profile จริงบน ephemeral thread ยังไม่ใช่ independent certification หรือ real multi-agent golden-path test
- [x] **Secret Sanitization Middleware (bounded MVP rules):** [commit scan](../apps/server/src/enterprise/EnterpriseSecretService.ts) ปฏิเสธ known credential/private-key patterns ก่อน checkout/check และ [redaction policy](../apps/server/src/enterprise/EnterpriseSecretPolicy.ts) ปิดบังค่าก่อน persist issue/check output; มี ordinary-source-file regression test ร่วมกับ filename, hook/filter และ environment guards ไม่รับประกันตรวจพบ secrets ทุกชนิดหรือ arbitrary encodings
- [x] **Merge Conflict Detection & Serialized Execution (service-level):** [merge service](../apps/server/src/enterprise/EnterpriseMergeService.ts) + [real-Git tests](../apps/server/src/enterprise/EnterpriseMergeService.test.ts) ใช้ repository-wide lock, immutable commits และ `merge-tree` ตรวจ conflict โดยไม่เปลี่ยน ref/index/checkout และปฏิเสธ executable merge drivers; `execute` ตรวจ `getEnterpriseApprovalBlockers` กับ commit ที่จะ merge, ปฏิเสธ branch ที่ checkout อยู่ใน worktree, สร้าง two-parent merge commit ด้วย `commit-tree` แล้วเลื่อน local branch ด้วย `update-ref` แบบ compare-and-swap (ปฏิเสธ `target_moved`) ไม่ push และไม่แก้ checkout; ผู้เรียกที่ขนาน/ซ้อนจะได้ `busy` (fail-closed ไม่ใช่ FIFO queue) ยังไม่มี RPC/UI ที่ authenticate approver และ actor permission ต้องตรวจโดยผู้เรียก

### 📋 Phase 2: Multi-Agent Issue-to-PR Golden Path (Weeks 5–6) — integrated implementation; live remote acceptance pending

**Current integration (17 October 2026):** `enterprise.startIssueWorkflow` authenticates the session before fetching a GitHub issue, freezes redacted issue text as untrusted context, preserves operator-owned grants/budget/routing, and starts the existing persisted automation. `enterprise.publishPullRequest` explicitly revalidates workflow readiness and publishes only its verified checkpoint to a deterministic new branch and a draft PR. It requires orchestration, filesystem-write and source-control-write scopes; it is not invoked automatically by background automation. No merge or approval is granted.

Publication records intent before the non-idempotent remote create. Retry first reconciles GitHub by repository, base, deterministic head, exact commit, draft/open state and same-repository ownership. An ambiguous create is not replayed when no matching PR is visible: `publication_unknown` requires operator reconciliation. A crash-held local lock is never reclaimed by age. Remote branch conflicts, repository-local URL/credential/HTTP overrides and changed publication targets are refused. Evidence is summarized in the PR body; the local gate artifacts remain on the owning environment.

**Local acceptance:** the reproducible headless harness `apps/server/scripts/verify-enterprise-live.ts` imports an Issue fixture through the real authenticated RPC/importer and runs real V2 roles through completed checkpoints, four sandboxed checks and a ready draft. Both docs/hybrid and source/cloud scenarios passed; only the intended file changed and repeated advance stayed ready. This is a local `gh` read fixture, not a real GitHub issue. The fixture refuses GitHub mutations.

**Remote acceptance deferred by user instruction:** the user selected “ทดสอบในเครื่องก่อน ยังไม่สร้างบน GitHub” on 17 October 2026. No repository, Issue or PR was created. Live remote publication, including reconciliation after a lost create response, therefore remains unverified. Eight focused publication service tests cover normal publication, conflicts and ambiguous-response recovery locally; they do not close this external gate.

- [x] **Typed Contracts Schema (initial implementation):** [TaskSpec, AgentHandoff, RiskDecision, PullRequestEvidence](../packages/contracts/src/enterprise.ts) พร้อม [schema/evidence-gate tests](../packages/contracts/src/enterprise.test.ts); role launch/release/collectHandoff/collectRoleArtifact มี typed RPC และ structured spec/QA schemas แล้ว แต่ยังไม่ใช่ durable Enterprise task-stage controller
- [x] **Evidence Verification Service & CLI (initial implementation):** [EnterpriseEvidenceService](../apps/server/src/enterprise/EnterpriseEvidenceService.ts) และ [t3 enterprise verify](../apps/server/src/cli/enterprise.ts) พร้อม [CLI integration tests](../apps/server/src/cli/enterprise.test.ts); ตรวจ declared evidence เท่านั้น ยังไม่รัน tests/scan จริงหรือ authorize merge
- [x] **Local Issue Trigger (CLI initial implementation):** [GitHub issue importer](../apps/server/src/enterprise/EnterpriseIssueService.ts) + [tests](../apps/server/src/enterprise/EnterpriseIssueService.test.ts) รองรับ issue URL และบันทึก untrusted context; UI picker ยังไม่ทำ และ live import ต้องมี `gh` ที่ติดตั้ง/authenticated (ต้องตรวจบน environment ที่ใช้รัน)
- [x] **Stage 1 (Architect/Spec Agent):** [V2 role service](../apps/server/src/enterprise/EnterpriseRoleService.ts) มี separate Architect thread, bounded untrusted context และ stable V2 command/message identity พร้อม [tests](../apps/server/src/enterprise/EnterpriseRoleService.test.ts); เพิ่ม [strict structured spec](../apps/server/src/enterprise/EnterpriseRoleOutput.ts) และ [validation tests](../apps/server/src/enterprise/EnterpriseRoleOutput.test.ts) แล้ว; Coder รับ spec จาก completed V2 run/ready checkpoint เท่านั้น ตรวจ task/base commit และ criteria ครบถ้วน ยังต้อง native-provider end-to-end acceptance
- [x] **Stage 2 (Worktree Coder Agent):** service รอ completed Architect run และใช้ owned worktree + Codex named write profile แล้ว; เพิ่ม `enterprise.collectHandoff` อ่าน completed run + ready checkpoint ของ V2 และ resolve commit ของ checkpoint เดิมแล้ว พร้อม regression cases สำหรับ HEAD ที่เปลี่ยน, checkpoint missing/stale/foreign, missing Git ref และ secret-bearing snapshot; เพิ่ม `enterprise.gateRole` เพื่อตรวจ snapshot ที่อ้างอิงใน handoff แล้ว; ยังต้อง quality acceptance และ real coding turn ไม่ถือว่า launch สำเร็จเท่ากับ implementation ผ่าน
- [x] **Stage 3 (Adversarial QA Agent):** QA มี independent thread/read profile, รับ bounded Git diff ของ completed Coder checkpoint และคืน structured findings (severity/path/line/regressionTest) แล้ว ตรวจ reviewed commit/criteria coverage และ checkpoint tree ต้องตรงกับ Coder; findings เป็นคำแนะนำ ยังไม่ใช่ผลรัน regression test ต้องทำ regression execution และ native malicious-input golden-path acceptance ต่อ
- [x] **Stage 4 (Deterministic Gate):** [gate executor](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts) รัน test/lint/typecheck/security-scan ภายใต้ ownership lock เดียว, ตรวจ clean HEAD ทุก check และบันทึก `gate-*.json` เมื่อทุก check ผ่านที่ commit เดียว พร้อม [behavior tests](../apps/server/src/enterprise/EnterpriseGate.test.ts) และ real isolated fixture ผ่านแล้ว; เพิ่ม snapshot gate ที่ resolve completed Coder checkpoint ผ่าน V2 และตรวจ detached checkout แยกจาก agent checkout แล้ว พร้อม [snapshot behavior tests](../apps/server/src/enterprise/EnterpriseSnapshotGate.test.ts) และ native Bubblewrap fixture ผ่านจริง; เพิ่มการอ่าน scoped server artifact กลับมาเทียบ task/run/checkpoint/check plan ก่อนประกอบ PR evidence แล้ว; มี supervised QA-backed correction ≤2 รอบพร้อม gate/draft ที่เลือก revision แล้ว; เพิ่ม `gateAndContinue` ตรวจ gate และเริ่ม correction จาก persisted failure แล้ว; มี workflow advance RPC แล้ว เพิ่ม background automation แล้ว แต่ native end-to-end acceptance และ hard-crash drills ยังไม่ครบ
- [x] **Stage 5 (PR Evidence Builder):** มี `enterprise.buildPullRequestDraft` สร้าง Proof-of-Work Markdown และ `PullRequestEvidence` จาก scoped server gate artifact ที่เทียบกับ V2 แล้ว พร้อม [renderer](../apps/server/src/enterprise/EnterprisePullRequestDraft.ts), [injection/redaction test](../apps/server/src/enterprise/EnterprisePullRequestDraft.test.ts) และ [service integration tests](../apps/server/src/enterprise/EnterpriseRoleService.test.ts); cost ยัง unknown, approval `not_evaluated` และยังไม่สร้าง remote PR หรือรับประกัน remote retry/reconciliation

**Native acceptance run (17 October 2026):** รัน server จริง (`t3 --base-dir <temp>`), pair เป็น bearer client, สร้างโปรเจกต์ผ่าน `projects.mutate` แล้วเรียก `enterprise.advanceWorkflow` กับ demo repo Python ที่ `add(a, b)` คืน `a - b` และ provider Codex (`gpt-6-luna`) ได้ผล: Architect → Coder → QA → deterministic gate (unittest/syntax/import/secret-scan ผ่านที่ checkpoint commit เดียว) → PR draft `ready` ใน ~1 นาที; Coder แก้ `calc.py` เป็น `a + b` เพียงบรรทัดเดียว; cost ยัง unknown และ approval `not_evaluated`

การรันจริงพบและแก้ 2 defects ที่ unit test ที่ mock V2 ไม่เห็น: (1) [getProjectThread](../apps/server/src/orchestration-v2/ThreadManagementService.ts) แปลง "ยังไม่เคยสร้าง thread" เป็น `ProjectionLoadError` ทำให้ workflow ใหม่เริ่มไม่ได้ (`launch_failed`) — ตอนนี้คืน `ThreadNotFound` พร้อม [test](../apps/server/src/orchestration-v2/ThreadManagementService.test.ts); (2) Codex 0.162.1 เปิด sandbox ไม่ได้เมื่อ `.codex`/`.agents` ที่ถูก deny ไม่มีใน checkout (`bwrap: Can't create file ...: Is a directory`) ทำให้ Coder แก้ไฟล์ไม่ได้และ QA ขอแก้ซ้ำจน `corrections_exhausted` — ตอนนี้ [workspace prepare](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts) สร้างโฟลเดอร์ว่างทั้งสอง (Git ไม่เห็น) พร้อม [test](../apps/server/src/enterprise/EnterpriseWorkspaceService.test.ts)

ขอบเขตที่ยังไม่ครอบคลุม: รันครั้งเดียว ไม่ใช่ pass-rate benchmark; issue context ใส่เอง (ไม่ผ่าน `gh`); ไม่สร้าง remote PR; ยังไม่ทดสอบ malicious-input/hard-crash drills (Phase 4) จึงไม่ติ๊กข้อ "Issue-to-PR golden path works on clean demo repo" ใน release gates

**Checkpoint-backed handoff (14 October 2026):** [implementation](../apps/server/src/enterprise/EnterpriseRoleService.ts) และ [focused behavior tests](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ใช้ `enterprise.collectHandoff` กับ `{ task, role, repositoryRoot, workspacesRoot }` หลัง role run completed และ checkpoint ready เพื่อรับ `AgentHandoff` ที่มี thread/run/model identity จาก V2, commit SHA จาก checkpoint Git ref และ `outputArtifactIds` เป็น checkpoint ID เดิม ใช้สิทธิ์ orchestration operate + filesystem write + source-control write เช่นเดียวกับ role workflow เดิม ไม่มี ledger, commit หรือ artifact store อีกชุด และไม่แก้ HEAD/worktree ระหว่างเก็บ handoff

`collectHandoff` คืน `testEvidence` และ `inputArtifactIds` ว่างโดยตั้งใจ เพราะ agent prose ไม่ใช่ผลตรวจจริง; structured QA artifact ที่อธิบายด้านล่างเพิ่ม Coder checkpoint IDs เป็น input provenance ส่วน passing checks ต้องมาจาก server snapshot gate เท่านั้น เมื่อไม่ระบุ `revision` Handoff อ้าง initial completed run ของรอบ 0; `revision: 1 | 2` เลือก completed run ของ correction นั้นโดยตรง ไม่ได้รับรอง arbitrary subsequent turns มี opt-in background automation แล้ว แต่ยังต้อง native golden-path acceptance และ recovery drills ก่อนปิด Stage 2/4

**Structured spec/QA (14 October 2026):** เรียก `enterprise.collectRoleArtifact` ด้วย `{ task, role: "architect" | "qa", repositoryRoot, workspacesRoot }` เพื่อรับ `{ artifactId, handoff, output }` ตาม [contracts](../packages/contracts/src/enterprise.ts) โดย `artifactId` คือ ID ของ final non-streaming assistant message ที่ persist ใน V2 และ handoff อ้าง run/ready checkpoint จริง ไม่สร้าง ledger หรือ artifact store อีกชุด Architect checkpoint ต้องมี tree ตรงกับ base commit; QA checkpoint ต้องมี tree ตรงกับ Coder checkpoint (commit ID ต่างกันได้ถ้าไฟล์เหมือนกัน)

[Output decoder](../apps/server/src/enterprise/EnterpriseRoleOutput.ts) รับเฉพาะ JSON ตาม schema ไม่เกิน 64 KiB, ปฏิเสธ extra fields/tool grants/approval spoof, task/commit ผิด, paths ที่ออกนอก repo/control metadata และ known secret patterns รวม JSON unicode escapes; acceptance criteria ต้องครบและไม่ซ้ำ QA verdict `pass` มี blocker/major findings ไม่ได้ ส่วน backend diff สำหรับ QA เกิน 64 KiB จะ fail closed ไม่ตัดทิ้งเงียบ ๆ [Service tests](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ใช้ real Git กับ fake V2/provider ports; [output tests](../apps/server/src/enterprise/EnterpriseRoleOutput.test.ts) ตรวจ invalid/adversarial JSON จึงยังไม่ใช่ผลจาก native model inference

Coder launch อ่าน validated Architect artifact แล้วส่ง canonical spec/message identity เป็น untrusted context; QA รับ reviewed commit และ diff จาก backend `regressionTest` เป็นข้อเสนอให้เขียนทดสอบ ส่วน `testEvidence` ยังว่าง ไม่มีการอนุมัติสิทธิ์หรือแปลงคำว่า pass ของโมเดลเป็น passing gate Draft ปัจจุบันยังไม่บังคับ QA pass และไม่อนุญาต publish/merge ด้วย QA report นี้

<a id="supervised-correction-rounds"></a>

**Supervised correction ≤2 รอบ (14 October 2026):** ใช้ `enterprise.launchRole` เดิมพร้อม `revision: 1 | 2` (ไม่ระบุหรือ `0` = รอบเริ่มต้น) เรียก Coder รอบ 1 หลัง structured QA รอบ 0 เป็น `request_changes` และมี findings; รอบ 2 ต้องใช้ QA รอบ 1 จึงข้ามรอบไม่ได้ Architect มีเฉพาะรอบ 0 หลัง Coder ของแต่ละรอบ completed ให้ launch QA ด้วย revision เดียวกัน แล้ว `collectRoleArtifact` จะตรวจ reviewed commit และ checkpoint tree ของ Coder รอบนั้น

[Role service](../apps/server/src/enterprise/EnterpriseRoleService.ts) ส่ง validated Architect spec และ QA findings/regression-test suggestions เป็น untrusted context ให้ Coder พร้อม persisted QA message identity ใช้ thread IDs `enterprise:<task-hash>:fix1:coder|qa` และ `fix2:coder|qa` กับ stable launch/message IDs ผ่าน receipts/outbox เดิม; ไม่เพิ่ม ledger และไม่ reset checkout ก่อนเริ่ม correction ใหม่ต้องไม่มี active run ใน bound threads, checkout ต้องสะอาดรวม ignored files และ HEAD tree ต้องตรงกับ snapshot ที่ QA ตรวจ มิฉะนั้นปฏิเสธ การ retry target ที่สร้างแล้วใช้ identity เดิมและตรวจ original prompt/worktree เช่นเดิม

`collectHandoff`, `collectRoleArtifact`, `gateRole` และ `buildPullRequestDraft` รับ revision เดียวกันเพื่ออ้างผลหลังแก้จริง ไม่เลือก latest ให้อัตโนมัติ [Behavior tests](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ใช้ real Git commits ที่ต่างกันในแต่ละรอบและตรวจ gate/PR draft อ้าง corrected commit/run; ปฏิเสธ revision 3, QA pass/ไม่มี findings, ข้ามรอบ, active work, dirty/ignored files และ checkout ที่เคลื่อนไปแล้ว [Runtime policy tests](../apps/server/src/enterprise/EnterpriseRuntimePolicy.test.ts) ยืนยัน correction Coder ได้ write profile ส่วน QA ยัง read-only แม้ thread ขอ full access

ส่วนนี้เป็น **supervised transitions** ผ่าน authenticated RPC; `gateAndContinue` ด้านล่างเริ่ม correction หลัง gate failure ได้ภายในหนึ่ง call การเรียก low-level RPC อย่างเดียวไม่เปิด automation; ใช้ `startWorkflow` ด้านล่างเพื่อให้ scheduler เรียกขั้นถัดไปหลัง model completion, ยังไม่สร้าง regression test อัตโนมัติจาก findings และยังไม่ใช่ native model golden path เมื่อหมดสองรอบให้ผู้เรียกหยุด/manual review; ไม่มี correction รอบ 3 และไม่มีการ publish/merge จาก QA verdict

**Snapshot gate (14 October 2026):** `enterprise.gateRole` รับ `{ task, role: "coder", repositoryRoot, workspacesRoot, plan }` โดย `plan` ต้องมี test/lint/typecheck/security_scan พร้อมชื่อไม่ซ้ำและ executable ที่ TaskSpec อนุญาต Server อ่าน completed run + ready checkpoint เอง ไม่รับ commit จาก client มาตัดสิน; ตรวจ detached `snapshot-checkout` ภายใต้ ownership lock เดิม และคืน `{ artifactId, handoff }` ที่เพิ่ม check evidence อ้าง commit/artifact เดียวกัน ผลสำเร็จบันทึกเป็น `gate-<uuid>.json` นอก sandbox (จำกัด 1 MiB, redacted logs) หลัง checks ผ่านครบและลบ snapshot checkout ได้ตามปกติแล้ว

หาก check ทำให้ snapshot dirty รวมถึง ignored files ระบบเก็บ checkout ไว้ตรวจสอบและปฏิเสธการใช้ path ซ้ำ ไม่ force-delete หรือย้อน HEAD ของ agent การ retry หลัง failure ที่ checkout ยังสะอาดทำได้โดยไม่แตะ agent checkout การทดสอบใช้ real Git + fake V2/provider ports และมี native Bubblewrap probe สำหรับ snapshot/isolation แยกต่างหาก; ยังไม่ใช่ model inference หรือ remote PR end-to-end

<a id="persisted-gate-failure-continuation"></a>

**Persisted gate-failure continuation (14 October 2026):** `enterprise.gateAndContinue` รับ launch-role fields เดิมกับ `role: "coder"`, `revision: 0 | 1 | 2` และ four-check `plan` ตาม [contracts](../packages/contracts/src/enterprise.ts) ใช้สิทธิ์ orchestration operate + filesystem write + source-control write ครบทั้งสาม Server อ่าน V2 completed run/ready checkpoint เอง แล้ว [workspace service](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts) ตรวจ snapshot ภายใต้ lock เดิม หากผ่านคืน `{ status: "passed", gate }`; หาก check exit ล้มเหลวและ snapshot ยังสะอาด ระบบลบ snapshot ตามปกติก่อน persist failure record นอก sandbox จึงเริ่ม Coder correction ถัดไปและคืน `{ status: "fix_started", failure, launch }` โดยไม่ต้องอาศัย QA verdict หากเป็น failure ของ revision 2 คืน `{ status: "blocked", failure }` และไม่ส่งรอบ 3

Failure ใช้ `gate-failure-<sha256>.json` โดย hash จาก authoritative handoff และ check plan เดิม เก็บ immutable TaskSpec, handoff, ชื่อ/kind ของ check ที่ล้มเหลว และ redacted plan ภายใน 1 MiB ไม่มี passing `testEvidence` หรือ raw failure logs ไม่เขียนทับ failure แรกของ key เดิม การอ่านกลับตรวจ task/run/commit/plan/grants และปฏิเสธ symlink/ไฟล์เกินขนาดก่อนใช้เป็น correction context นี่คือ scoped control artifact แบบเดียวกับ gate evidence ไม่ใช่ execution ledger ใหม่หรือ signed approval

การเรียกซ้ำใช้ persisted failure ก่อนรัน checks จึงไม่ rerun gate ที่ล้มเหลวสำหรับ continuation เดิม และ prompt/command identity ของ correction คงเดิม ใช้กู้ช่วงที่ persist failure สำเร็จแต่ยังไม่ launch ได้ [Service fixtures](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ตรวจ retry/recovery boundary และ exhaustion สองรอบผ่าน real Git กับ fake V2/provider/sandbox ports; [artifact tests](../apps/server/src/enterprise/EnterpriseSnapshotGate.test.ts) ตรวจ tamper/symlink/oversize/foreign run/plan และแยก failure ออกจาก passing gate artifact ยังไม่ใช่ process-kill/native-provider recovery drill

Timeout แยกเป็น `check_timed_out` ใน [sandbox](../apps/server/src/enterprise/EnterpriseSandboxService.ts); timeout, sandbox unavailable, snapshot dirty/ignored หรือ orphan ไม่สร้าง recoverable check-failure record และไม่ auto-launch correction Checkout ของ agent ยังต้องตรงกับ snapshot และไม่มี active bound runs ก่อนเริ่มงานใหม่ QA-backed และ gate-backed corrections ใช้สองรอบร่วมกัน หากใช้ low-level RPC ต้องเรียก QA/gate ด้วย revision หลังแก้ต่อเอง หรือใช้ `advanceWorkflow` เพื่อเลือกขั้นและ revision ให้ ส่วน `startWorkflow` เปิด background progression ถึง PR draft แต่ยังไม่ใช่ remote Issue-to-PR runner ที่มี PR reconciliation และไม่อนุญาต publish/merge

<a id="v2-workflow-advance"></a>

**V2-backed workflow advance (15 October 2026):** `enterprise.advanceWorkflow` รับ `{ task, repositoryRoot, workspacesRoot, modelSelection, issueContext, plan }` ตาม [contracts](../packages/contracts/src/enterprise.ts) ไม่มี stage/revision ที่ client ใช้ข้ามขั้น [Workflow service](../apps/server/src/enterprise/EnterpriseWorkflowService.ts) อ่าน role threads, initial runs และ ready checkpoints จาก V2 เพื่อเลือกขั้นถัดไป: Architect → Coder → QA → gate → PR draft เมื่อ QA ขอแก้หรือ deterministic gate ล้มเหลว ใช้ correction รอบ 1–2 ชุดเดียวกับ role service เดิม ไม่สร้าง provider execution pipeline หรือ run ledger ใหม่

ก่อนเริ่มตรวจ project root และ TaskSpec ต้องให้ read/write role grants รวม executable ทุกตัวใน plan อย่างชัดเจน Ownership เดิมเก็บ `workflowKey` เป็น SHA-256 ของ configuration ที่ผ่าน schema และ redact issue context แล้ว ภายใต้ operation lock ไม่เก็บ issue/plan ดิบเพิ่มใน manifest การเรียก `advanceWorkflow` ครั้งถัดไปต้องใช้ configuration เดิม; digest เป็น consistency guard ของ RPC นี้ ไม่ใช่ approval หรือระบบ authorization ใหม่ งานที่มี manually launched bound role threads อยู่ก่อนโดยยังไม่มี workflow binding จะไม่ถูก adopt อัตโนมัติ ให้ใช้ task identity ใหม่สำหรับ managed workflow แทนการแก้ manifest เอง

ผลลัพธ์เป็น `running` พร้อม role/revision/thread ID, `waiting_checkpoint`, `blocked` พร้อม normalized reason หรือ `ready` พร้อม evidence-backed draft เมื่อ run ยังทำงานจะไม่เริ่มขั้นถัดไป; checkpoint missing รอ update, error/stale หยุด; failed/cancelled/interrupted runs, archived/deleted threads และ manual turns เพิ่มจาก initial run ต้อง manual reconciliation QA pass ยังต้องผ่าน deterministic gate ครบ และ draft ยังเป็น `approvalStatus: "not_evaluated"` ไม่มี remote PR/publish/merge

RPC นี้เป็น **คำสั่ง advance แบบเรียกซ้ำได้** ไม่ใช่ background worker ให้รอ V2 run/checkpoint updates แล้วเรียกด้วย configuration เดิม จึงเดินขั้นถัดไปได้หลัง reconnect/restart หากต้องการให้ server wake เองเมื่อโมเดลจบให้ลงทะเบียนผ่าน `startWorkflow` ด้านล่าง การเรียกซ้ำขณะ role ยังทำงานคืนสถานะเดิมและใช้ launch/message identity เดิม; หากเรียกอีกหลัง `ready` จะตรวจ gate ใหม่ก่อนสร้าง draft จึงไม่ควรใช้ RPC นี้เป็น polling endpoint ของ UI ใช้ V2 streams สำหรับติดตามงานแทน

[Integration fixtures](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ใช้ Workflow service + Role service + Workspace จริง กับ real Git และ fake V2/provider/sandbox ports ครอบคลุม normal path, QA correction, gate correction, exhaustion, active runs, checkpoint wait/error, closed/manual threads, malformed spec, foreign checkout และ configuration drift [Workspace tests](../apps/server/src/enterprise/EnterpriseWorkspaceService.test.ts) ตรวจ workflow digest ข้าม service instances และป้องกัน adoption งานเดิม; [authorization tests](../apps/server/src/auth/RpcAuthorization.test.ts) ตรวจสาม scopes ของ RPC ใหม่ นี่ยังไม่ใช่ live model inference หรือ physical process-kill recovery drill

<a id="background-workflow-automation"></a>

**Background workflow automation (15 October 2026):** `enterprise.startWorkflow` รับ input เดียวกับ `advanceWorkflow` และใช้ session ID จาก authenticated WebSocket connection โดย server ไม่รับ owner identity จาก payload ผลลัพธ์คือ `{ automation, state }` พร้อม stage แรกที่ยอมรับแล้ว `enterprise.stopWorkflow` และ `enterprise.getWorkflowAutomation` รับ `{ task, repositoryRoot, workspacesRoot }` และคืน `{ registered, enabled, stopReason }`; ทั้งสาม RPC ต้องมี orchestration operate + filesystem write + source-control write ครบ

[Automation service](../apps/server/src/enterprise/EnterpriseWorkflowAutomation.ts) ใช้ [scheduler กลางเดิม](../apps/server/src/scheduling/Scheduler.ts) ซึ่งรอ startup recovery ก่อนทำงานและตรวจประมาณทุก 5 วินาที ค้น registration จาก persisted Architect threads ของ V2 แล้วเทียบ event sequences ของ role threads จึงไม่เรียก advance ซ้ำเมื่อไม่มีการเปลี่ยนแปลง; checkpoint-ready events เปลี่ยน sequence ได้แม้ thread timestamp ไม่เปลี่ยน จากนั้นใช้ Workflow/Role services เดิมเดิน Architect → Coder → QA → gate/corrections → evidence-backed draft โดยใช้สองรอบแก้ร่วมกัน

Configuration และ opt-in intent อยู่ใน `workflow-automation.json` ข้าง ownership นอก checkout ของ agent ผ่าน operation lock เดิม เก็บ normalized input, owner session ID, enabled flag และ bounded stop reason ไม่เก็บ bearer token หรือ progress/run/event log อีกชุด การอ่านตรวจ task identity, project, canonical paths, workflow digest, symlink และขนาด 1 MiB; start ปฏิเสธ known secret patterns ใน configuration หลัง redact issue ก่อนเริ่มโมเดล แต่ไม่ได้รับประกัน arbitrary encoded secrets ทุกชนิด Registration จะถูก acknowledge หลัง V2 initial thread และไฟล์ configuration บันทึกแล้ว; ช่วงก่อน acknowledgement ที่ขาดตอนยังอาจต้อง retry start ด้วย input เดิม

ก่อน advance แต่ละครั้ง worker ตรวจ owner session จาก auth repository เดิมใหม่ว่าไม่ถูก revoke/หมดอายุและยังมีสาม scopes ครบ หากไม่มีสิทธิ์ปิด automation ด้วย `authorization_required` การสร้าง service ใหม่อ่าน registration เดิมได้โดยไม่ต้องมี browser/client เชื่อมต่อ และยังต้องผ่าน project/workspace guards เดิม ทุก role dispatch ใช้ V2 command/message identities เดิม ไม่มี outbox หรือ provider execution pipeline เพิ่ม

เมื่อพร้อม draft, blocked หรือพบ non-retryable error worker จะปิด opt-in และบันทึก stop reason (`ready`, `blocked`, `error`) จึงไม่รัน gate ซ้ำทุก tick หลังงานจบ; busy ownership lock จะรอ tick ถัดไป `stopWorkflow` รอ advance ที่กำลังทำให้จบก่อนปิดการเริ่มขั้นถัดไป โดยไม่ interrupt provider turn ที่ส่งไปแล้ว ส่วนการยกเลิกทั้ง workflow ใช้ `cancelWorkflow` ด้านล่าง การ start ใหม่ด้วย configuration เดิมและ session ที่ยังมีสิทธิ์เป็นการเปิด automation อีกครั้ง

[Integration fixtures](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ใช้ Automation + Workflow + Role + Workspace จริง กับ real Git และ fake V2/provider/sandbox/auth ports ครอบคลุม scheduler registration, normal/QA/gate correction, exhaustion, no-change dedupe, stop, session revoke/expiry/scope loss, unsafe registration และการสร้าง service ใหม่เพื่ออ่าน configuration เดิม [Registration IO tests](../apps/server/src/enterprise/EnterpriseWorkspaceService.test.ts) ตรวจ symlink/oversize/foreign task/config drift; [RPC authorization tests](../apps/server/src/auth/RpcAuthorization.test.ts) ตรวจ scopes ของ endpoints ใหม่

<a id="workflow-cancellation"></a>

**Workflow cancellation (15 October 2026):** `enterprise.cancelWorkflow` รับ scope เดียวกับ stop/status และใช้ session จาก authenticated connection ต้องมีทั้งสาม scopes Server ตรวจ session ใหม่แล้วบันทึก `enabled: false`, `stopReason: "cancelled"` และ session ผู้ขอยกเลิกก่อนส่งคำสั่ง Stop ไปยัง role threads ที่ ownership ผูกไว้ ตรวจ task-specific thread identity, project และ worktree ของทุก thread ก่อนส่งคำสั่งแรก โดยใช้ [V2 `thread.stop` เดิม](../apps/server/src/orchestration-v2/Orchestrator.ts) เพื่อ interrupt turn และพักคิว รวม background work ตาม semantics ของ V2 ผลลัพธ์ `{ automation, stopRequests }` คือคำสั่งที่ V2 ยอมรับ ไม่ใช่หลักฐานว่า provider process หยุดสำเร็จแล้ว

Command ID อิง thread/run/attempt identity เดิม จึงเรียกซ้ำผ่าน command receipts/outbox เดิมได้ หากส่งได้บางส่วน cancellation intent ยังอยู่ และ worker ที่สร้างใหม่จะอ่าน intent แล้วลองส่งต่อ โดยตรวจสิทธิ์ผู้ขอยกเลิกอีกครั้ง การค้นงานหลัง restart ยังอาศัย Architect thread ใน active shell; หากถูก archive/delete ต้องเรียก cancel เองเพื่อจัดการ role threads ที่เหลือ หากสิทธิ์หมดเปลี่ยนเป็น `authorization_required` และต้องให้ผู้มีสิทธิ์เรียก cancel ใหม่ Scheduler ใช้ event sequences เพื่อลดการส่งซ้ำเมื่อไม่มีการเปลี่ยนแปลง ไม่สร้าง cancellation ledger หรือ outbox เพิ่ม และไม่อ้างว่า external effects ทุกชนิด replay ได้ปลอดภัยโดยอัตโนมัติ

[Cancellation integration fixtures](../apps/server/src/enterprise/EnterpriseRoleService.test.ts) ตรวจ intent-before-dispatch, duplicate command identity, partial dispatch + service reconstruction, new attempt ของ run เดิม, revoked session ทั้งก่อน cancel และก่อน recovery, deleted thread และ foreign worktree โดยใช้ real Git/Workspace/Workflow กับ fake V2/auth/provider ports ขอบเขตนี้ยังไม่ใช่การ kill process ระหว่าง production gate: cancel รอ service semaphore และ gate/advance ที่กำลังทำอยู่ก่อน จึงยังไม่ติ๊ก Phase 4 recovery drill ทั้ง milestone

**Production startup probe (background-automation baseline ก่อนเพิ่ม cancellation RPC):** server bundle เปิดด้วย temporary T3 home ได้ HTTP 200 และยังทำงานหลัง scheduler tick โดยไม่มี missing-service/scheduler failure; temporary V2 database มี 0 runs และ process ที่ probe สร้างถูกปิดแล้ว นี่เป็น startup verification ไม่ใช่ native model inference การทดสอบ hard crash ที่ทิ้ง ownership lock, cancellation ระหว่าง gate และ remote PR reconciliation ยังไม่ผ่าน; lock ค้างต้อง manual recovery ไม่ยึดคืนตามอายุ และ crash ระหว่าง gate ผ่านกับการปิด opt-in อาจทำให้ตรวจ gate ซ้ำหลัง restart แต่ไม่ได้สร้าง remote PR

**Artifact-backed PR draft (14 October 2026):** เรียก `enterprise.buildPullRequestDraft` ด้วย `{ task, role: "coder", repositoryRoot, workspacesRoot, artifactId }` โดยใช้ artifact ID จาก `gateRole` Server อ่านไฟล์เฉพาะ control directory ของ task ภายใต้ lock เดิม ตรวจชื่อ UUID, ปฏิเสธ symlink/ไฟล์เกิน 1 MiB และเทียบ immutable TaskSpec, V2 handoff, checkpoint commit, check plan/ผลตรวจ ก่อนสร้าง draft การส่ง path หรือ declared evidence จาก client แทนไฟล์จริงไม่ผ่าน

ผลลัพธ์คือ `{ evidence, body, approvalStatus: "not_evaluated" }` โดย `evidence.cost.amountCents` เป็น `null` และไม่แต่งเป็นศูนย์ Markdown escape ข้อมูล untrusted และ redact known secret patterns ก่อนแสดงรายงาน การตรวจ artifact นี้อาศัย trusted local control storage และ consistency กับ V2; ไม่ใช่ authenticated risk approval หรือ attestation ป้องกันผู้ที่เขียน host filesystem ได้ และไม่ได้อนุญาต publish/merge

### 📋 Phase 3: Hybrid Router & Native Ollama GPU Profile (Weeks 7–8) — scoped integration and repeated benchmark verified

- [x] **Local Ollama inference using the Codex harness:** Enterprise selections use `instanceId: "codex"`, `model: "ollama/<installed-model>"`. The existing adapter explicitly sets a loopback Responses provider for thread start/resume and normalizes the model at turn start. The named filesystem/network profile is preserved. The role service probes tool capability and refuses cloud-backed Ollama models. This replaces the proposed standalone driver with the existing agent loop and avoids a second orchestration implementation.
- [x] **Workflow routing:** `routing.candidates` is typed operator configuration. Architect and QA stay on cloud; Coder can use local only when `preferLocalDocs` is enabled and the validated Architect spec contains only documentation paths. The collected local checkpoint is checked again; source-code changes cannot be accepted as documentation. Routing is configured at workflow start and bound to its immutable configuration.
- [x] **Bounded provider failover:** persisted V2 error items supply cooldowns for usage limits / explicit retryable 429/503/529 errors. A failed role can dispatch at most two provider retries through existing V2 commands and receipts, without consuming QA correction rounds. Only a different model on the same inference backend is used. Modified/committed partial work, manual runs, unknown costs and non-retryable failures stop automation. Cross-backend fallback is permitted only before dispatch and only when explicitly enabled.
- [x] **Budget and cost integration:** routed workflows require configured pricing, and an unpriced candidate is not launched. Actual usage is attributed through attempt → run → immutable model selection; changing a thread model does not retroactively reprice previous turns. Invalid numeric data and overflow stop accounting safely. Limits are checked between completed turns; one in-flight turn can still overrun its budget. Explicit zero pricing is a deliberate accounting input, not a measurement of GPU/electricity cost.
- [x] **Reproducible scoped cloud/local comparison:** five fixed native cases (inference, scoped read/host-secret denial, exact documentation write, document revision and cross-document consistency), repeated three times on each backend. Both use the same rubric and shared final-file/temporary-artifact Coder instructions. Cloud `gpt-6.1-sol`: **15/15**; local `qwen3-coder:30b`: **13/15**. Local's two failures changed document formatting outside the requested edits. The initial prompt version scored cloud 15/15 and local 11/15; those failures remain in separate reports. No failed samples were dropped or rerun into the same output files. The offline summarizer requires every planned sample and matching prompt versions.

The revised comparison measured median elapsed time 8.53 s cloud / 6.78 s local. Summed per-turn rounded API-equivalent cloud cost was USD 0.53 using explicit short-context rates; actual subscription charges, GPU/electricity and hardware costs remain unknown. Local zero provider pricing is an accounting assumption. These synthetic results support an **explicit opt-in documentation-only** route, with cloud Architect/QA and deterministic gates. They do not establish a broad coding pass rate, production readiness or general cost savings. Benchmark evidence remains outside the checkout; commands are documented for reproduction.

See [Ollama setup and acceptance commands](./user/providers-ollama.md). Focused coverage: [workflow routing](../apps/server/src/enterprise/EnterpriseWorkflowRouting.test.ts), [role retry and local validation](../apps/server/src/enterprise/EnterpriseRoleService.test.ts), [native acceptance](../apps/server/src/enterprise/EnterpriseOllama.live.test.ts), [cost attribution](../apps/server/src/enterprise/EnterpriseTaskCost.test.ts).

<a id="phase-4-v2-enterprise-recovery"></a>

### 📋 Phase 4: Durability, Recovery & Security Hardening (Weeks 9–10) — In Progress (0/5 milestones complete)

**Baseline ตรวจสอบแล้ว (13 October 2026):** [Orchestration V2 ใช้งานใน server แล้ว](./orchestration-v2/README.md#current-implementation-and-phase-4-boundary) บน checkout `511d20c6f20c2ed6ff787aba068d7d673e2949b9`; event/projection/receipt/outbox transaction, worker recovery และ provider restart มี implementation และ focused tests แล้ว สถานะ 0% ของ Phase 4 หมายถึงงาน Enterprise extension ด้านล่าง ไม่ใช่ V2 ทั้งระบบยังไม่ทำ และไม่ใช่ผลทดสอบ live providers

**ส่วนที่เริ่มทำแล้ว:** [pure evidence gate](../packages/contracts/src/enterprise.ts) ตรวจ task/commit, budget, decision, expiry และ policy version; [service/CLI](../apps/server/src/enterprise/EnterpriseEvidenceService.ts) ใช้ runtime clock และปฏิเสธ malformed/oversized bundles การตรวจนี้ยังไม่ใช่ authenticated approval persistence, remote PR reconciliation หรือ crash recovery จึงยังไม่ติ๊ก milestones ด้านล่าง

**ทำร่วมกับ Phase 1/2:** เพิ่ม durable task transitions, stable operation identity และ authorization ตั้งแต่สร้าง task runner / PR integration; Phase 4 เป็นการ harden และทดสอบ recovery เพิ่มเติม ไม่รอถึง W9 จึงเริ่มออกแบบความถูกต้อง

**สถานะ integration / dependencies:** [V2-backed workflow advance](#v2-workflow-advance), [persisted background automation](#background-workflow-automation) และ [cancellation intent/retry](#workflow-cancellation) มี implementation แล้ว โดยใช้ V2 เป็นแหล่ง progress แต่ authenticated approval persistence, native Issue-to-PR acceptance, remote PR reconciliation และ hard-crash recovery drills ยังขาด ห้ามทำเครื่องหมาย Phase 4 ผ่านจาก schema validation หรือผลทดสอบ V2 เดิมเพียงอย่างเดียว

- [ ] **Extend Existing V2 Ledger & Outbox:** ต่อยอด event persistence, projections, command receipts และ effect outbox เดิมสำหรับ Enterprise task transitions, handoff, evidence และ approval; เพิ่ม schemas/persistence เฉพาะส่วนที่ยังขาด ไม่สร้าง ledger, event bus หรือ outbox อีกชุด
- [ ] **External Operation Identity & Reconciliation:** ใช้ operation key ที่คงเดิมเมื่อ retry; ก่อนสร้าง PR ซ้ำให้ตรวจสถานะใน remote repository และบันทึก remote identity/result หากปลายทางไม่รองรับ idempotency โดยตรง; เมื่อผลลัพธ์ไม่แน่นอนและตรวจคืนไม่ได้ ให้หยุดรอ manual recovery
- [ ] **Approval Recovery & Revalidation:** บันทึก actor, diff/commit identity, policy version และ expiry; หลัง restart/reconnect ต้องตรวจสิทธิ์และ diff ล่าสุดก่อนใช้ approval เดิม และไม่ถือว่า offline action ได้รับอนุมัติแล้ว
- [ ] **Crash/Reconnect/Cancel Recovery Drills:** ทดสอบ duplicate commands, restart, reconnect และ cancellation รวมถึง crash หลังสร้าง PR สำเร็จแต่ก่อนบันทึกผลในเครื่อง; ต้องกู้สถานะได้โดยไม่สร้าง PR ซ้ำ และไม่ replay effects ของ provider process ที่สูญหายอย่างอัตโนมัติ
- [ ] **Prompt Injection Defense:** ทดสอบชุดข้อมูลอันตราย (Adversarial Fixtures) ใน Issue/Repo เพื่อป้องกันยกระดับสิทธิ์

### 📋 Phase 5: Founder Cockpit, Kanban & Mobile Approvals (Weeks 11–12) — 0%

- [ ] **Kanban Work Order Queue:** แสดงสถานะงานตาม Stage (Queued, Running, Verifying, Awaiting Approval, PR Opened)
- [ ] **Tiered Risk Approval Engine:** บังคับใช้นโยบาย Tier 0/1 (manual approval), Tier 2 (ผู้อนุมัติที่แตกต่างกันอย่างน้อย 2 คน); MVP ไม่ Auto-Merge
- [ ] **Mobile Approval Screen:** ต่อยอดหน้าจออนุมัติบน React Native Mobile ที่มีอยู่เดิมใน T3 Code
- [ ] **Ephemeral Web Preview:** เสิร์ฟ Port Dev ชั่วคราวให้ผู้ใช้เปิดดูหน้าตาเว็บไซต์จริงก่อนกด Approve

### 📋 Phase 6: Beta Release & Open-Source Launch (Weeks 13–14) — 0%

- [ ] **60-Second Real Workflow Video:** บันทึกคลิปวิดีโอสาธิตจริง (Issue ➔ Agent Pipeline ➔ Evidence PR)
- [ ] **Copy-Paste Quickstart Guide:** คู่มือติดตั้ง 1 คำสั่งพร้อม Sample Repository ตัวอย่าง
- [ ] **Reproducible Benchmark Suite:** เผยแพร่ผลทดสอบ Pass Rate, ต้นทุนจริง และสเปกฮาร์ดแวร์ให้ชุมชนตรวจสอบซ้ำได้
- [ ] **GitHub Launch Polish:** จัดทำ README ฉบับสมบูรณ์, Issue Templates, Contributing Guidelines, และ Tag Release

---

## 02 / Technical audit & source-of-truth

Verified vs proposed vs audit-needed

### ✅ Confirmed from upstream docs

T3 Code มี Web, Electron Desktop, React Native Mobile, authenticated RPC, server-side execution, provider adapters, contracts และ shared client runtime แล้ว

การเพิ่มฟีเจอร์ต้องคำนึงถึง client surfaces, provider adapters, wire contracts, reconnect semantics และ app performance

SOURCE VERIFIED

### 🔎 Must audit against pinned commit

จุด extension เฉพาะของ orchestration, event persistence, checkpoint semantics, worktree manager, auth permissions และ UI component boundaries ต้องอ่าน source code ของ commit ที่ Fork จริง

ตำแหน่งไฟล์ใน v2.0 ให้ถือเป็น **proposed files** ไม่ใช่ยืนยันว่ามีอยู่แล้ว

REQUIRES CODE AUDIT

| v2 assumption                 | Current finding                                                 | v3 action                                                                |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Local CLI harness เท่านั้น    | มี server, web, desktop, mobile และ remote control              | ออกแบบเป็น extension ไม่สร้าง frontend ทั้งหมดใหม่                       |
| สร้าง apps/mobile ใหม่        | upstream มี React Native mobile                                 | ทำ approval screen บน mobile เดิมหรือ shared runtime                     |
| เพิ่ม orchestration ใหม่ทันที | มี orchestration ที่ apps/server                                | ตรวจ adapter/service boundary ก่อนเพิ่ม package                          |
| cloud provider adapters ใหม่  | รองรับ Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity | ต่อยอด provider-aware routing และ Ollama adapter เป็น extension ตามสัญญา |
| 100% replay / zero collision  | ไม่ใช่ผลที่รับประกันด้วย worktree/event log                     | ใช้ idempotency, isolated execution, recovery drills และ measured SLO    |

## 03 / Risk register & remediations

Priority-based engineering controls

| Priority | Risk                                    | Remediation                                                                                                                                                                                                         | Pass criteria                                                   |
| -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P0       | Tenant authorization & data leaks       | Tenant-scoped policy on every RPC, artifacts, jobs; cross-tenant access tests. **Current MVP:** `tenantId` is recorded in TaskSpec only; RPCs authorize by environment scope, not tenant (single-tenant local host) | Block release until authz and isolation tests pass              |
| P0       | Agent execution / sandbox escape        | Disposable container or microVM, read-only mounts, resource limits, egress policy, no inherited secrets                                                                                                             | Malicious task cannot read host secrets or arbitrary paths      |
| P0       | Unsafe auto-merge / deployment          | Default manual PR, protected branches, branch policy and two-person signoff for critical changes                                                                                                                    | Critical diff cannot merge without required approvals           |
| P0       | Duplicate side effects on replay        | Idempotency tokens, transactional state transitions, safe resume and manual recovery actions                                                                                                                        | Server restart does not duplicate PR/deploy/database writes     |
| P1       | Prompt injection / secret exfiltration  | Treat repo/issues as untrusted data, tool allowlists, secret detection and deny-by-default network                                                                                                                  | Adversarial fixtures cannot elevate instructions                |
| P1       | Worktree collisions and merge conflicts | Task-specific worktrees plus conflict detection, serialized merge queue and cleanup                                                                                                                                 | Parallel edits produce detected conflicts, not silent overwrite |
| P1       | Misleading cost or speed promises       | Track provider pricing, GPU cost, retries and benchmark confidence intervals                                                                                                                                        | Publish reproducible measurement and real assumptions           |
| P1       | Provider compatibility / upstream drift | Pin upstream commit, capability negotiation, contract tests across 3 clients                                                                                                                                        | Supported-provider smoke tests pass on tagged release           |
| P1       | Missing quality evidence                | Deterministic CI, tests, code scan, screenshot artifacts, provenance                                                                                                                                                | Every demo PR shows pass/fail artifacts                         |
| P1       | Approval spoofing / stale state         | Signed/authenticated actor identity, approval expiry, audit event and reconnect refresh                                                                                                                             | Expired or offline approval cannot silently authorize merge     |

**Security default:** ห้าม Auto-Approve migrations, production deploys, permission changes, dependency scripts, auth, billing, secrets, infrastructure และ network-policy changes. การสแกนความลับแบบ mask อย่างเดียวไม่เพียงพอ; ต้องจำกัด secrets/network/effective permissions ตั้งแต่ execution boundary

## 04 / Target architecture

Adapt T3; preserve upstream boundaries

### Proposed layered architecture

**Founder / Developer / Client UX**Web • Desktop • Existing Mobile • GitHub PR

▼ Typed RPC + authenticated capability checks

**Enterprise Application Services**Tasks • Agent Handoff • Policy • Budget • PR Evidence

▼ Contracts + event/workflow state

**T3 Server / Provider Adapters**Workspace owner • Codex / Claude / others • Ollama (proposed)

▼ Controlled job execution

**Sandbox & Git Worktrees**Per-task mounts • network rules • resource limits • merge queue

▼

**Persistence & Observability**Run events • artifacts • idempotency keys • logs • metrics

### Initial implementation: contracts and evidence verification

[Contracts](../packages/contracts/src/enterprise.ts) ใช้ thread/run/project IDs และ model selection ของ V2 เดิม; งบและต้นทุนเป็น USD cents, unknown cost เป็น `null`, Git identity เป็น full SHA-1/SHA-256 และ approval ผูก task, commit, policy version และ expiry (Unix epoch milliseconds)

[EnterpriseEvidenceService](../apps/server/src/enterprise/EnterpriseEvidenceService.ts) อ่าน JSON bundle `{ task, evidence, risk }` ตาม schemas และใช้ server clock ตรวจ expiry; [CLI](../apps/server/src/cli/enterprise.ts) เรียก service นี้โดยไม่สร้าง database, ledger หรือ outbox เพิ่ม

จาก checkout ใช้:

```sh
node apps/server/src/bin.ts enterprise verify --bundle ./bundle.json --commit <current-full-commit-sha> --policy-version <current-policy-version>
```

คำสั่งนี้ตรวจ **declared evidence**: schema, task/commit consistency, check results, security scan, budget และ approval metadata; ไม่รัน tests/scan, ไม่ตรวจความแท้จริงของ artifacts/actor, ไม่บันทึก approval และไม่อนุญาต merge/deploy ค่า commit และ policy ต้องมาจากบริบทที่เชื่อถือได้ เมื่อมี runtime integration ต้องตรวจ authorization และหลักฐานจริงอีกครั้ง

[Contract tests](../packages/contracts/src/enterprise.test.ts) และ [CLI integration tests](../apps/server/src/cli/enterprise.test.ts) ครอบคลุม budget bounds, manual/dual approval, stale diff, missing/failed evidence, policy/expiry revalidation, malformed JSON และขนาด bundle; task execution และ durable recovery ยังเป็นงานถัดไป

### Phase 0–2: CLI entry points and acceptance limits

[Workspace service](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts), [sandbox adapter](../apps/server/src/enterprise/EnterpriseSandboxService.ts), [merge preflight](../apps/server/src/enterprise/EnterpriseMergeService.ts) และ [issue importer](../apps/server/src/enterprise/EnterpriseIssueService.ts) มี local CLI entry points; role workflow ใช้ authenticated V2 RPC ตามส่วนด้านล่าง

```sh
node apps/server/src/bin.ts enterprise issue import --url https://github.com/OWNER/REPO/issues/1 --output ./issue-context.json
node apps/server/src/bin.ts enterprise worktree prepare --spec ./task.json --repo /absolute/repository --workspaces-root /absolute/task-workspaces
node apps/server/src/bin.ts enterprise worktree check --spec ./task.json --repo /absolute/repository --workspaces-root /absolute/task-workspaces --check ./check.json
node apps/server/src/bin.ts enterprise worktree cleanup --spec ./task.json --repo /absolute/repository --workspaces-root /absolute/task-workspaces
```

`task.json` ใช้ TaskSpec schema; tool grants มาจาก spec ที่ operator เชื่อถือ ไม่ได้มาจาก issue body `check.json` มี `name`, `kind` (`test`/`lint`/`typecheck`/`security_scan`), `tool` (absolute `/usr/bin/...` ที่อยู่ใน approvedTools), `args` และ `timeoutMs` (1–120000)

Checks ต้องเริ่มและจบโดย checkout ไม่มี tracked/untracked changes และ HEAD ไม่เปลี่ยนระหว่างรัน; artifacts ผูกกับ HEAD ที่ทดสอบจริง สำเร็จจึงบันทึก `check-*.json` ข้าง ownership manifest ภายใต้ operation lock ถ้า sandbox ใช้ไม่ได้จะคืน failure และไม่บันทึก passing evidence ไม่ถือว่า artifact นี้เป็น authenticated approval

CLI prepare/check/gate/cleanup ผ่านบน temporary repositories จริง; gate failure ไม่สร้าง passing artifact และปล่อย lock อย่างถูกต้อง Role services/permissions มี focused tests และ native profile probes แล้ว แต่ยังไม่มี end-to-end Architect → Coder → QA → Auto-Fix → evidence-backed PR จึงยังไม่ใช่ Issue-to-PR golden path ที่เสร็จแล้ว

**V2 role RPC (initial implementation):** `enterprise.launchRole` รับ [typed input](../packages/contracts/src/enterprise.ts) สำหรับ `architect`, `coder`, `qa`; TaskSpec ต้องอนุมัติ `codex.workspace_read` สำหรับ Architect/QA และ `codex.workspace_write` สำหรับ Coder อย่างชัดเจน; empty allowlist ถูกปฏิเสธ ต้องมี `orchestration:operate`, `filesystem:write`, `source-control:write` ใน destination environment ใช้ ThreadLaunchService/command receipts/outbox เดิม ไม่มี execution ledger ใหม่ [Runtime policy](../apps/server/src/enterprise/EnterpriseRuntimePolicy.ts) จำกัด MVP ไว้ที่ Linux/npm default Codex `0.162.1`, grants เฉพาะ checkout + runtime/toolchain, ปิด command network, secret environment, project-local Codex configuration, web search/apps/plugins/native subagents/hooks/goals และ configured MCP servers; unsupported provider/version/installation layout ต้อง fail closed

**Release/cleanup:** หยุด/ลบ role threads ผ่าน V2 เดิม แล้วเรียก `enterprise.releaseWorkspace`; server ต้องเห็น deleted threads, terminal runs และ stopped sessions ครบก่อน retire binding จากนั้น CLI cleanup ยังตรวจ dirty files/new commits และไม่ลบ branch การมี stable launch IDs ไม่ได้รับประกัน external effects ทุกชนิด replay-safe โดยอัตโนมัติ

### Integration contracts

```
TaskSpec {
  taskId, tenantId, projectId,
  repoCommit, acceptanceCriteria,
  approvedTools, budgetLimit
}
AgentHandoff {
  inputArtifactIds, outputArtifactIds,
  modelId, runId, commitSha,
  testEvidence, errors
}
RiskDecision {
  tier, policyVersion, matchedRules,
  approvers, expiry, decision
}
PullRequestEvidence {
  diffSha, tests, securityScan,
  screenshots?, cost, provenance
}
```

บันทึกเฉพาะข้อมูลที่จำเป็นและเก็บ artifact ตามนโยบาย retention; ไม่เก็บ token, secrets หรือ raw prompts ที่เป็นความลับโดยไม่จำเป็น

### Failure semantics

ใช้ [Orchestration V2 ledger/outbox ที่มีอยู่แล้ว](./orchestration-v2/README.md#durable-effect-outbox--implemented): events, persisted projections, command receipt และ effects ถูก commit ใน transaction เดียว จากนั้น worker จึงทำ side effects; acknowledgement หมายถึง intent ถูกบันทึกแล้ว ไม่ใช่งานภายนอกเสร็จแล้ว

Outbox และ command deduplication ไม่รับประกัน exactly-once external execution: remote operation อาจสำเร็จก่อน process ล่มและยังไม่บันทึกผล Tool/PR integrations ต้องมี stable operation key, state reconciliation, checkpoint, compensating action หรือ manual recovery ตามชนิดของงาน ไม่ replay ทุก effect โดยอัตโนมัติ และไม่เปิด database ใหม่เพียงเพื่อทำ ledger ซ้ำ

### Tenant boundary

Tenant-scoped authorization บนทุก RPC, data row, artifact และ worker; deny-by-default

### Supply-chain defense

Pin versions, SBOM, dependency audit, signed release workflow และ upstream sync checks

### Execution boundary

Worktree เป็น isolation ของ Git; container/microVM + mount/network controls จึงเป็น security layer

## 05 / Agent assembly line + quality contracts

Independent evidence, not agent consensus

01 / SPEC**Architect**Issue → scoped spec, definition of done, test plan, risk estimate

02 / IMPLEMENT**Coder**Changes inside disposable worktree; limited shell & repo access; enforce clean code, modular architecture & meaningful comments

03 / CHALLENGE**Adversarial QA**Reviews changed behavior; writes regression & edge tests; audits code smells, cleanliness & maintainability; no silent signoff

04 / VALIDATE**Deterministic Gate**Lint & formatting (oxlint/prettier), typecheck, tests, clean code policy, secret scan, visual preview

05 / DELIVER**PR Evidence**Diff, artifacts, risks, costs and an explicit merge/approval decision

### Task state machine

```
QUEUED → SCOPED → RUNNING
  → VERIFYING → AWAITING_APPROVAL
  → PR_OPENED → COMPLETED

Failure → RETRYABLE / BLOCKED
Cancellation → CANCEL_REQUESTED
  → TERMINATED → CLEANUP_VERIFIED
```

ทุก transition ตรวจ authorization + idempotency; timeout และ cancellation ถูกจัดการเหมือน feature หลัก ไม่ใช่ edge case

### Policy: no false confidence

ไม่ใช้ LLM judge เพียงตัวเดียวเป็นตัวชี้ว่าคุณภาพผ่าน ต้องมี test artifacts ที่เรียกซ้ำได้และ deterministic gate; QA agent ต้องมี prompt/context แยกจาก coder เท่าที่เป็นไปได้

**Retry budget:** max 2 auto-fix cycles by default; ไม่เพิ่มงบเอง; failed review คืนให้มนุษย์หรือ re-scope task

## 06 / MVP scope & prioritization

Build what earns trust before feature expansion

### MVP Must-Have

- **Issue → PR golden path** — Import issue, scope task, run 5-stage agent workflow, open evidence-backed PR
- **Safe workspace** — Git worktrees, disposable sandbox, constrained execution and merge guard
- **Proof-of-Work card** — Show changed files, checks, tests, risk, screenshots where available
- **Manual approval inbox** — Founder/developer review and approve or reject with audit metadata
- **Local/Cloud model routing** — Initial provider-aware routing; Ollama proof of concept; budget caps
- **Starter kit & benchmark** — Sample repository, first-run guide, real demo and reproducible success checks

### V1 Growth

- **Multi-project cockpit** — Portfolio, health, WIP limits, team roles, tenant-aware views
- **Visual browser QA** — Screenshot diff, preview links, responsive viewport and accessibility scans
- **Cost and profitability** — Project-level budget forecasting, GPU/Cloud blended cost and margin
- **More integrations** — GitLab, issue trackers and notifications after demand validation
- **Semantic code retrieval** — Selective context, symbol graph and measured retrieval accuracy
- **Learning from feedback** — Project rules and searchable evidence with retention controls

### V2 / Enterprise

- **Enterprise SaaS controls** — SSO, SCIM, advanced tenant isolation, retention and enterprise policy
- **Billing operations** — Invoices, payment workflows, reconciliation, taxes and contract pricing
- **Fleet compute scheduling** — Remote GPU pools, quotas, autoscaling, multi-machine scheduling
- **Compliance programs** — Formal audit preparation and standards-based security controls
- **Plugin marketplace** — Stable extension API, vetted community plugins and permissions
- **Long-horizon agents** — Multi-epic planning with explicit human checkpoints and disaster recovery

**Explicit non-goals for MVP:** SaaS multi-tenant public cloud, automated payments/invoicing, one-click production deployment, unbounded autonomous runs, guaranteed 100% correctness และการฝึกโมเดลเอง — เหล่านี้เพิ่มความเสี่ยงโดยไม่ช่วยพิสูจน์ core value เร็วขึ้น

## 07 / Interactive UX/UI prototype

Clickable conceptual screens; no live backend

### Founder Cockpit

Portfolio metrics, live Kanban by task stage, agent runs, provider utilization, cost & approvals (UX concept; not connected to live backend)

### Developer Pipeline

Per-task timeline, spec/diff, test outcomes, logs, rerun/retry decisions and handoff evidence (UX concept; not connected to live backend)

### Mobile Approval

Responsive approval inbox with signed-in actor, risk tier, diff summary, evidence and approve/reject action (UX concept; not connected to live backend)

### Client Proof-of-Work

Read-only progress, changes, screenshots, pass/fail tests, limitations and PR status (UX concept; not connected to live backend)

### Information architecture

Portfolio → Project → Issue/Task → Run → Evidence → PR. มี breadcrumb, global search, filter และ keyboard-first actions

### Critical UX states

Loading, retry, offline, reconnect, conflict, pending approval, deny reason, partial success และ cancellation feedback

### Visual differentiation

Calm engineering console: อินดิโก้ + teal, typography ชัด, content density ปรับได้, ลด animation และมี responsive/mobile-first approvals

## 08 / Local vs Cloud cost calculator

Editable assumptions — illustrative, not live pricing

วางแผนต้นทุนรวมโมเดล, ไฟฟ้าและค่าเสื่อมอุปกรณ์อย่างง่าย เพื่อทดสอบ Business Case จริง ตัวเลขเริ่มต้นเป็นเพียงตัวอย่าง

Tasks per month500 (editable in HTML)

Average cloud cost / task (USD)0.40 (editable in HTML)

Local tasks (%)55 (editable in HTML)55%

Local effective cost / task (USD)0.08 (editable in HTML)

Retry overhead (%)15 (editable in HTML)

Fixed monthly infra costs (USD)20 (editable in HTML)

Cloud-only baseline**—**

Hybrid estimated total**—**

Estimated net savings**—**

Reduction vs baseline**—**

Excludes staff review, storage, downtime, installation, tax, model quality differences and extra task rework. Treat savings estimates as hypotheses until measured.

## 09 / 14-week MVP → pilot roadmap

Sequential milestones; parallel work possible

W1–W2 · PHASE 0

### Technical Audit & Architecture Decisions

Pin upstream commit, inspect server/contracts/client-runtime, licensing, telemetry and permission flows; threat model; define extension strategy and ADRs

Exit: agreed contracts, smoke build & risk register

W3–W4 · PHASE 1

### Safe Task Execution

Task lifecycle, worktrees, disposable sandbox, scoped filesystem/network, cancellation, protected Git flows, repo bootstrap

Exit: parallel task isolation tests pass

W5–W6 · PHASE 2

### Multi-Agent Issue-to-PR Golden Path

Spec/Code/QA contracts, GitHub issue import, evidence artifacts, deterministic gates, manual PR approval

Exit: end-to-end demo on template repository

W7–W8 · PHASE 3

### Hybrid Router & Local GPU Profile

Provider-aware routing, Ollama adapter prototype, budget limits, token telemetry and benchmark suite; model-level recovery handling

Exit: reproducible cloud/local quality + cost results

W9–W10 · PHASE 4

### Durability, Recovery & Security Hardening

Extend existing V2 ledger/outbox for Enterprise task state, evidence and approvals; reuse checkpoints and command receipts; add remote-operation reconciliation, retry/failure drills, prompt-injection defenses, security scan and focused recovery tests

Exit: restart/reconnect/cancel and duplicate-command scenarios pass, including a crash after remote PR creation but before local settlement; no duplicate PR is created

W11–W12 · PHASE 5

### Founder Cockpit, Developer UX, Mobile Approval

Kanban, run timeline, diff and previews, mobile inbox extending current app, budget views, accessible navigation

Exit: user journey usability evaluation

W13–W14 · PHASE 6

### Beta Release & Open-Source Launch

CI matrix, signed artifacts where supported, installer docs, demo videos, sample repos, reproducible evaluation, issue templates

Exit: pilot readiness gates + public beta release

**Schedule confidence:** 14 weeks is a planning scenario, not a delivery guarantee. Solo development or a major upstream fork conflict may require longer. Multi-tenant SaaS enterprise hardening remains outside this MVP.

## 10 / GitHub star-worthy launch strategy

Discovery → first success → community trust

WOW / 60 SEC

### Animated workflow showcase

15–45s real recording: GitHub Issue → Agent pipeline → tests → proof-backed PR. Use actual runs, not staged fictional success metrics

TIME TO VALUE

### Copy-paste quickstart

Documented demo setup; preflight checks for OS, provider auth, Docker, Git and permissions; one sample repo, one task

TRUST

### Reproducible benchmarks

Publish task sets, baselines, pass rates, costs, hardware and failure cases. Let users repeat the evaluation

### Distinctive README

Clear problem statement, comparison, video/GIF, feature matrix, architecture, install, limitations, screenshots and roadmap

### Community contribution path

Good-first-issue labels, bug templates, RFC/ADR process, public discussions, security reporting and upstream attribution

### Polished releases

Changelog, semantic tags, checksums, reproducible build notes, support matrix, migration notes and demo dataset

### North-star product & community measures

| Metric                     | Suggested pilot target              | Measurement                                         |
| -------------------------- | ----------------------------------- | --------------------------------------------------- |
| First successful run       | ≥ 70% of eligible beta testers      | Opt-in tester study, local privacy-safe counters    |
| Time to first Issue-to-PR  | Median ≤ 15 min on demo repo        | From first run start to evidence-backed PR          |
| Golden-path task pass rate | ≥ 80% on fixed benchmark set        | Reproducible acceptance tests, include all failures |
| Unauthorized execution     | 0 in adversarial test suite         | Security test matrix and reviewed logs              |
| GitHub stars               | Directional indicator, no guarantee | Stars/week + unique contributors + issue quality    |
| Return usage               | Measure weekly active beta testers  | Opt-in survey or locally owned statistics           |

Stars ไม่ใช่ตัวแทนของ software quality โดยตรง: ให้ความสำคัญกับ first successful run, retention, issue resolution และ contributor experience มากกว่า vanity metric

## 11 / MVP release checklist

Interactive readiness evaluator, stored in this browser session only

0%

0 / 12 release gates verified

**NOT READY — validation required**

ติ๊กเฉพาะข้อที่ผ่านการทดสอบจริง คะแนนนี้เป็น checklist ไม่ใช่การสแกนโค้ดหรือการรับรองความปลอดภัย

1. [ ] Upstream pinned-commit audit and extension ADRs signed off
2. [ ] Threat model, permission boundaries, secret handling reviewed
3. [ ] Isolated task execution tests incl. malicious repo content pass
4. [x] Agent handoff schema and deterministic tests validated — [contracts](../packages/contracts/src/enterprise.test.ts), [V2 handoff/gate/draft service tests](../apps/server/src/enterprise/EnterpriseRoleService.test.ts), [snapshot tests](../apps/server/src/enterprise/EnterpriseSnapshotGate.test.ts); focused fixtures, not full native golden-path acceptance
5. [ ] Issue-to-PR golden path works on clean demo repo
6. [ ] Merge/approval policy blocks all critical changes without review
7. [ ] Restart, retry, cancel and duplicate-PR recovery tests pass
8. [ ] Budget controller and honest measured cost attribution verified
9. [ ] UI supports keyboard navigation, mobile and error states
10. [ ] CI, package/license audit, installer smoke tests pass
11. [ ] README, demo, benchmark reproduction and security policy published
12. [ ] Independent pilot tester completes first successful run

<a id="implementation-map"></a>

## 12 / Implementation map & action plan

Proposed module placement; verify at fork commit

<a id="implementation-evidence"></a>

### Implementation evidence: Blueprint ↔ V2 ↔ Source ↔ Tests

ฐานด้านล่างมีอยู่แล้ว ให้ต่อยอดตาม boundary เจ้าของงาน; คอลัมน์สุดท้ายแยก MVP ที่เพิ่มแล้วออกจากงานค้าง ผลทดสอบ V2 baseline ไม่ได้รับรอง Enterprise pipeline ทั้งหมด

| ขอบเขต                            | เอกสารอ้างอิง                                                                                                                                                                      | Implementation เดิม                                                                                                                                                                                                              | Tests สำหรับตรวจสอบ                                                                                                                                                                                                                                                                                | Enterprise ที่ยังต้องเพิ่ม                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Atomic persistence / outbox       | [V2 outbox](./orchestration-v2/README.md#durable-effect-outbox--implemented), [architecture](./internals/overview.md#durable-intent-and-side-effects)                              | [EventSink](../apps/server/src/orchestration-v2/EventSink.ts), [EffectOutbox](../apps/server/src/orchestration-v2/EffectOutbox.ts)                                                                                               | [FoundationPersistence](../apps/server/src/orchestration-v2/FoundationPersistence.test.ts)                                                                                                                                                                                                         | Task/evidence/approval persistence ที่เชื่อมกับระบบเดิม — [Phase 4](#phase-4-v2-enterprise-recovery)                                                                                                                                                       |
| Retry / cancel / restart          | [Enterprise cancellation](#workflow-cancellation), [Recovery boundary](./orchestration-v2/README.md#recovery-boundary), [testing strategy](./orchestration-v2/testing-strategy.md) | [EffectWorker](../apps/server/src/orchestration-v2/EffectWorker.ts), [ProviderRuntimeRecoveryService](../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)                                                     | [EffectWorker tests](../apps/server/src/orchestration-v2/EffectWorker.test.ts), [runtime recovery tests](../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts), [restart replay](../apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts) | Persisted workflow/cancel retry มีแล้ว; hard-crash drills และ remote PR reconciliation — [Phase 4](#phase-4-v2-enterprise-recovery)                                                                                                                        |
| Fork / handoff / merge-back       | [Thread lineage](./orchestration-v2/thread-lineage-and-context-transfer.md)                                                                                                        | [ThreadForkService](../apps/server/src/orchestration-v2/ThreadForkService.ts), [ContextHandoffService](../apps/server/src/orchestration-v2/ContextHandoffService.ts)                                                             | [fork tests](../apps/server/src/orchestration-v2/ThreadForkService.test.ts), [handoff tests](../apps/server/src/orchestration-v2/ContextHandoffService.test.ts), [merge-back integration](../apps/server/src/orchestration-v2/testkit/ThreadMergeBack.integration.test.ts)                         | [Checkpoint handoff/gate/draft](../apps/server/src/enterprise/EnterpriseRoleService.ts) อ้างอิง V2 แล้ว; มี structured spec/QA จาก persisted V2 message แล้ว; มี supervised correction ≤2 รอบแล้ว; ยังขาด native acceptance และ hard-crash recovery drills |
| Provider execution / rollback     | [Capabilities](./orchestration-v2/provider-capability-system.md), [feature lifecycles](./orchestration-v2/feature-lifecycles.md)                                                   | [ProviderAdapterRegistry](../apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts), [CodexThreadRevert](../apps/server/src/provider/CodexThreadRevert.ts)                                                                 | [capability policy tests](../apps/server/src/orchestration-v2/CommandPolicy.test.ts), [revert tests](../apps/server/src/provider/CodexThreadRevert.test.ts), [adapter tests](../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts)                                                  | Ollama ใช้ Codex Responses profile เดิม และ routing เชื่อมกับ workflow แล้ว; comparative acceptance ยังเปิดอยู่                                                                                                                                            |
| Workspace / delegated tasks       | [Orchestrator MCP](./orchestration-v2/orchestrator-mcp-server.md)                                                                                                                  | [WorktreeMcpService](../apps/server/src/mcp/WorktreeMcpService.ts), [OrchestratorMcpService](../apps/server/src/mcp/OrchestratorMcpService.ts)                                                                                   | [worktree tests](../apps/server/src/mcp/WorktreeMcpService.test.ts)                                                                                                                                                                                                                                | [Task ownership/snapshot gates](../apps/server/src/enterprise/EnterpriseWorkspaceService.ts) และ [sandbox](../apps/server/src/enterprise/EnterpriseSandboxService.ts) เพิ่มแล้ว; scheduled GC และ Issue-to-PR acceptance ยังไม่ครบ                         |
| Permissions / approvals / clients | [Environment auth](./internals/environment-auth.md), [connection runtime](./internals/connection-runtime.md)                                                                       | [RpcAuthorization](../apps/server/src/auth/RpcAuthorization.ts), [client commands](../packages/client-runtime/src/operations/commands.ts), [RuntimeRequestService](../apps/server/src/orchestration-v2/RuntimeRequestService.ts) | [runtime request tests](../apps/server/src/orchestration-v2/RuntimeRequestService.test.ts), [client command tests](../packages/client-runtime/src/operations/commands.test.ts)                                                                                                                     | Enterprise approval ที่ผูก actor/diff/policy/expiry และ revalidation — [Phase 4](#phase-4-v2-enterprise-recovery)                                                                                                                                          |

**V2 baseline audit (13 October 2026):** focused runs รอบ audit ก่อน implementation Enterprise ผ่าน 155 tests ครอบคลุม persistence, worker/recovery, fork/handoff/merge-back, runtime requests, contracts, capability policy และ Codex rollback/replay บางกรณี; adapter/replay ใช้ name filters ในบางชุด ไม่ได้รันทุก test ที่ลิงก์ไว้ ชุด replay ทุก provider ถูกยุติก่อนจบและไม่ใช่ live-provider verification การตรวจครั้งถัดไปให้รันเฉพาะ test ที่เกี่ยวข้องตาม [development runbook](./operations/development.md) และ [verification rules](../AGENTS.md#verifying)

### Integration touchpoints

```
apps/server/
  enterprise/tasks/          [proposed]
  enterprise/agents/         [proposed]
  enterprise/policy/         [proposed]
  enterprise/evidence/       [proposed]
  enterprise/local-routing/  [proposed]
apps/web/src/
  features/enterprise/       [proposed]
apps/mobile/
  [add approval UI to existing app]
packages/contracts/
  [extend typed RPC schemas]
packages/client-runtime/
  [shared state, reconnect, permissions]
```

แนวทางนี้ตั้งใจไม่สร้าง `apps/mobile` หรือ `packages/orchestrator` ซ้ำ โดยต้องยืนยัน build graph และ dependency boundaries หลัง code audit

### V2 + Enterprise ownership boundaries

| ส่วน          | ใช้ฐานเดิม                                                        | สิ่งที่ Enterprise เพิ่ม (proposed)                                                 |
| ------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Execution     | V2 commands/events, provider adapters, run graph และ checkpoints  | Task stages และ agent handoff ที่อ้างอิง thread/run เดิม                            |
| Durability    | EventSink, projections, command receipts และ EffectOutbox         | Task-domain schemas, evidence references และ recovery rules ของ external operations |
| Workspace     | Git/worktree services เดิม                                        | Task ownership, sandbox boundary และ cleanup ที่ตรวจงานค้างก่อนลบ                   |
| Authorization | Server-side RPC permissions และ shared client permission handling | Approval policy ที่ผูก actor, diff/commit, expiry และ audit metadata                |
| Clients       | Contracts และ client-runtime สำหรับ reconnect/state               | Task timeline, evidence viewer และ approval UI บน web/desktop/mobile                |

Enterprise services เรียกใช้ V2 ผ่าน service/contracts ที่มีอยู่; ความสามารถที่ยังขาดให้ขยายที่ boundary เจ้าของงาน ไม่สร้าง provider execution pipeline หรือฐานข้อมูล orchestration คู่ขนาน การเปลี่ยน persisted events และ wire contracts ต้องรักษา replay และ client/server compatibility

### First engineering PRs

1. ADR-001: fork strategy + ownership boundaries
2. ADR-002: tenant/user auth and execution threat model
3. Contracts: TaskSpec, AgentHandoff, Evidence, RiskDecision
4. Deterministic task runner + disposable worktree
5. End-to-end golden-path fixture repository
6. Evidence viewer + manual approval with audit trail
7. Local adapter benchmark and budget-controller rollout

### Stack decision

TypeScript-first where upstream uses TS, existing T3 server/contracts/client runtime, Git/GitHub integration; sandbox runtime selected after threat model; existing persistence audited before choosing new DB; Ollama added only through supported provider boundaries

Suggested acceptance tests (expand)

Concurrent agents edit same file → detected and gated merge conflict; malicious issue injects prompt instruction → not promoted to system permissions; container escapes/symlink reads → denied; failing test blocks PR approval; budget exceeded → task stops with reason; restarted server → resumable state without duplicate PR; token expiry → invalidates approvals; mobile offline → no false approval acknowledgment; unsupported provider → explicit capability fallback; accessibility keyboard-only flow → usable.

Design system requirements (expand)

Semantic typography scale, contrast tested to WCAG AA targets, 44px mobile hit targets where practical, keyboard shortcuts with documented alternatives, focus states, reduced-motion support, loading/skeleton/error/empty states, no GPU-heavy background animations, design tokens and snapshots across desktop/tablet/mobile.

What v3 intentionally does NOT promise

No 100% correctness, no guaranteed 65–80% cost reduction, no deterministic sub-50ms full provider failover, no guaranteed zero git conflicts, no auto-safe SQL migrations, no security certification from a dashboard checklist, and no guarantee of GitHub star count.

## 13 / Sources, provenance & status

Last reviewed: 17 October 2026

**Source document:** user-provided _T3 Code Enterprise Blueprint & Roadmap v2.0.html_ (six pillars, five-stage pipeline, tiered risk matrix, 10-week roadmap).

**Verified external references:** [T3 Code upstream repository](https://github.com/pingdotgg/t3code) • [Maintainer architecture guidance](https://github.com/pingdotgg/t3code/blob/main/AGENTS.md) • [Architecture overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) • [Docs index](https://github.com/pingdotgg/t3code/blob/main/docs/README.md).

**Document status:** This document mixes the original proposal with implemented fork features. The current status and acceptance boundaries above take precedence over historical roadmap descriptions. Source implementation and focused tests do not certify production readiness or close unexecuted live acceptance gates.

**Fork governance:** Preserve original MIT license and attribution; inspect all dependency licenses; monitor upstream changes; publish differentiation honestly and avoid implying official T3 endorsement.
