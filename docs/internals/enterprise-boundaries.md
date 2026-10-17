# Enterprise ownership boundaries

## ADR-001: Extend the local server and preserve V2

Decision: keep this fork as a local, single-operator extension of T3. Web, desktop
and mobile still control execution on the owning environment. Enterprise work
must use existing contracts, server services and V2 thread/run/provider identities.
Do not create another provider orchestrator, event log or effect outbox.

Task workspace ownership is a filesystem resource record, not an execution ledger.
[EnterpriseWorkspaceService](../../apps/server/src/enterprise/EnterpriseWorkspaceService.ts)
records the immutable TaskSpec and pinned checkout allocation outside the source
repository. It reuses the Git driver, disables checkout hooks and submodules,
and refuses configured checkout filters. Allocation cannot be considered a
completed V2 run or a successful agent task.

The ownership record and Git operation cannot share a database transaction. A
crash between checkout creation and manifest commit therefore leaves an ambiguous
allocation. The service rejects reuse without matching ownership; it does not
silently delete or adopt the checkout. An operation lock left after a crash
requires operator recovery, not age-based takeover.

Role stages attach to V2 through authenticated services and extend
its existing persistence where required. The local tenant label in TaskSpec does
not implement SaaS tenant isolation. Issue content must never supply tool grants,
authenticated actor identity or environment permissions.

Background automation persists only configuration and opt-in intent outside the agent
checkout. The shared scheduler discovers it through persisted V2 Architect thread
ownership; V2 remains the source of progress. The stored session ID is a reference,
not a credential: each advance revalidates expiry, revocation and scopes against
the auth repository. Disabling automation stops future dispatch. Explicit cancellation
persists disabled intent before sending existing V2 Stop commands; partial dispatch retries
reuse V2 receipts and revalidate the cancelling session. A committed Stop request does not
prove provider termination. See the [operating boundary](../T3_Code_Enterprise_Blueprint_v3_MVP.md#background-workflow-automation).

## ADR-002: Execution threat model and fail-closed checks

Decision: treat repository content, Git configuration, issues and declared
artifacts as untrusted inputs. Checks run through the CLI or protected role RPC;
merge preflight remains local CLI, and evidence-gated merge execution is a service-level API without a transport handler. Enterprise role workflow RPCs require
execution, filesystem-write and source-control-write grants on the destination
environment; transport handlers call the domain service.

| Boundary                | Current control                                                                                                                            | Remaining limitation                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout preparation    | Pinned full commit; separate worktree; hooks disabled; filters refused; tracked secret filenames refused                                   | Content recognizers are bounded patterns; no arbitrary repository setup scripts                                                       |
| Workspace ownership     | Tenant/project/task-derived directory; immutable spec; exclusive operation lock; branch/common-directory verification                      | Filesystem records are trusted local control data, not multi-tenant storage                                                           |
| Cleanup                 | Never force-remove; refuse dirty/ignored files, new commits, mismatched checkout or held lock; retain branch                               | V2 bindings block cleanup until deleted threads, terminal runs and stopped sessions are verified; no scheduled GC                     |
| Check process           | Linux Bubblewrap, isolated namespaces, cleared environment, one writable checkout mount, no host home or Git metadata mount                | Linux-only; not a container/microVM certification or remote-agent sandbox                                                             |
| Resources               | prlimit address-space, CPU, process/file limits; runner timeout and output bound                                                           | No cgroup fleet scheduling; limits need workload-specific validation                                                                  |
| Network and credentials | Namespace isolation; no network namespace sharing; no inherited provider credentials inside sandbox                                        | Cloud provider parent processes retain subscription access; command execution needs its separate native profile                       |
| Evidence and approvals  | Snapshot gate records V2 provenance outside the sandbox; draft building rereads scoped records and checks task/run/commit/plan consistency | Local control storage is trusted; record consistency does not authenticate a risk approval or protect against host filesystem writers |

[EnterpriseSandboxService](../../apps/server/src/enterprise/EnterpriseSandboxService.ts)
probes the sandbox before running a check. Missing binaries, unsupported
namespaces or a failed probe stop execution; there is no host-shell fallback.
Successful checks write bounded output artifacts outside the checkout. Failed
or interrupted checks must not produce passing evidence.

Named Codex permission profiles are required for role threads. Legacy `readOnly`
policy can still allow host reads; it is not a secrecy boundary. The adapter uses
an explicit deny-by-default filesystem profile and avoids sending legacy sandbox
policy overrides on turns, which would replace that profile. It disables discovered
MCP servers using valid inert transports, clears command environment inheritance,
and skips repository-local Codex configuration. TaskSpec explicitly grants native role capabilities separately from check
executables; an empty tool allowlist never grants native execution. Native subagent collaboration,
hooks and goal continuation are disabled; V2 owns the role launches. See the [official permissions
guide](https://learn.chatgpt.com/docs/permissions) for profile scope and controls
that need separate enforcement. The Linux/npm MVP pins the default Codex CLI to
0.162.1; other versions, providers and installation layouts need explicit tests.

Real namespace, host-home/environment and egress fixture checks passed outside
the tool's outer sandbox, as did native profile read/egress checks and the adapter's
ephemeral native thread/start configuration. Process limits run inside the PID
namespace so they do not count the owning user's host threads. No inference turn
or remote PR was created during these profile probes.

Release gates remain open: independent review, full native multi-agent adversarial
fixtures, authenticated approvals, live remote PR reconciliation and V2 recovery drills.
Bounded QA corrections, provider retries and explicit draft publication now have implementations
and focused fixtures; those do not close the live acceptance gates. A passing local check artifact or
an accepted native thread configuration does not close these gates.

Local inference reuses the Codex adapter with an explicit loopback Responses provider; it does
not introduce another orchestration ledger or tool loop. Routing is immutable workflow intent.
Only validated documentation-only Coder work qualifies automatically, and collected local diffs
are checked again. Native retry messages are bounded identities in the existing V2 thread;
partial filesystem changes and unknown costs prevent replay. See the [Ollama operating
boundary](../user/providers-ollama.md#enterprise-local-routing).

Issue-start and draft publication are explicit authenticated operations. Publication's small
filesystem receipt tracks one external side-effect intent, not task/run progress. An ambiguous
remote create is reconciled, never blindly retried; stale locks require operator recovery.
It publishes a pinned checkpoint to a new deterministic remote branch and never merges it.

## ADR-003: Environment-level tenant boundary

**Decision.** An environment serves only the tenants its operator lists in `<T3 home>/userdata/enterprise-tenants.json`:

```json
{ "version": 1, "tenants": ["acme", "globex"] }
```

- **No file:** the environment serves only the default tenant `local`.
- **Listing tenants replaces the default.** Add `local` to the list to keep it.
- **Unreadable, invalid or oversized (over 64 KiB) file:** no tenant is served (fail closed).
- **Re-read on every check.** Removing a tenant takes effect at the next RPC or background step, without a restart.

**Enforcement points.** All three call [`EnterpriseTenancy`](../../apps/server/src/enterprise/EnterpriseTenancy.ts):

1. **Every Enterprise RPC** (`ws.ts`) is checked before any work starts, including the GitHub issue fetch, and returns `tenant_not_allowed`.
2. **Every workspace operation** (`EnterpriseWorkspaceService`) is checked before any filesystem effect. This covers CLI, RPC and worker paths alike. Task state is keyed by `sha256(tenantId, projectId, taskId)`, so two tenants with the same task ID never share a workspace, manifest or artifact.
3. **Background automation** re-checks the tenant together with the owner session on each tick. A revoked tenant stops the worker with `authorization_required`.

**Not covered (follow-up).** This boundary separates tenants on one host. It does not separate users who share an environment.

- Binding a tenant to an authenticated session needs a tenant claim issued at pairing time.
- The local CLI has no server config, so it always uses the default (`local` only).

## ADR-004: Authenticated approvals revalidated on every use

**Decision.** Merge approval comes from authenticated people and is recomputed every time it is read. It is never trusted from a stored flag or from a client.

- **Recording.** `enterprise.recordApproval` takes the actor from the WebSocket connection's session, never from the payload. Each [entry](../../packages/contracts/src/enterprise.ts) pins:
  - `sessionId` and `subject`
  - `approve` or `reject`
  - the verified `diffSha` from a fresh `EnterpriseWorkflowService.verify`, which re-runs the deterministic gate
  - `ENTERPRISE_APPROVAL_POLICY_VERSION`
  - `decidedAt` and `expiresAt`, at most 24 hours later

  Entries are stored in `approvals.json` beside the ownership manifest, appended under the task operation lock. A newer decision from the same session for the same commit replaces its earlier one.

- **Revalidation.** [`EnterpriseApprovalService`](../../apps/server/src/enterprise/EnterpriseApprovalService.ts) recomputes the `RiskDecision` from scratch on every `getApproval`, `recordApproval` and `mergeTask`. An entry counts only if all of these hold:
  - its commit equals the current verified commit
  - its policy version is current
  - it has not expired by the server clock
  - its session is still unrevoked, unexpired and holds all three Enterprise scopes, re-read from the auth repository

  Ignored entries are reported with a reason. A restart, a reconnect, a new Coder revision or a revoked session therefore cannot revive an old approval.

- **Risk policy.** [`EnterpriseRiskPolicy`](../../apps/server/src/enterprise/EnterpriseRiskPolicy.ts) classifies the server's own diff of base → verified commit:
  - **Tier 2, two distinct approving sessions:** migrations, CI/deploy, permissions/CODEOWNERS, dependency manifests and lockfiles, auth, billing, secrets, infrastructure and network policy.
  - **Tier 1, one approving session:** everything else.

  There is no tier 0 and no auto-approval. Any valid rejection wins.

- **Merge.** `enterprise.mergeTask` proceeds only with zero `getEnterpriseApprovalBlockers` (commit, checks, security scan, known cost within budget, approval, expiry, policy). It then calls the existing compare-and-swap merge service, which re-checks the blockers with its own clock, refuses a moved target and never pushes.

**Why not a V2 event.** V2 events and projections are thread-scoped and replayed by three clients. An Enterprise approval is task-scoped and must be revalidated against live auth state anyway. Adding approval events would change the replay contracts for every client without making revalidation unnecessary. The approval file is therefore a scoped control artifact, like gate evidence: audit input, never authorization by itself.

**Known limits.**

- "Distinct approvers" means distinct authenticated sessions. Until tenant and identity claims are bound at pairing (ADR-003 follow-up), one person holding two sessions can satisfy tier 2.
- Path rules are deliberately broad but are not a semantic analysis of the change.
