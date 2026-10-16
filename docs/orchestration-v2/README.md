# Orchestration V2

This document set records the V2 design and its invariants. The durable effect outbox described below is implemented in the current server. For current ownership and persistence constraints, see the [architecture overview](../internals/overview.md). Some companion documents describe the original target model; implementation changes must preserve compatibility with persisted events and independently versioned clients.

V2 is an orchestrator rewrite, not a rewrite of the whole app domain platform. Existing non-orchestration domains, persistence/migration infrastructure, websocket/RPC infrastructure, and projection streaming semantics should be retained unless V2 exposes a concrete orchestration-specific gap.

V2 is designed around the real provider behavior observed in the Codex app-server probes, but it is not Codex-specific. Codex is treated as the richest protocol we currently have; weaker providers are adapted into the same model with app-owned ids and explicit capability flags.

## Documents

- [Core Graph And Data Model](./core-graph-and-data-model.md)
- [Entity IDs And Correlation](./entity-ids-and-correlation.md)
- [Feature Lifecycles](./feature-lifecycles.md)
- [Thread Lineage And Context Transfer](./thread-lineage-and-context-transfer.md)
- [Provider Switching And Context Handoff](./provider-switching-and-context.md)
- [Orchestrator MCP Server](./orchestrator-mcp-server.md)
- [Provider Capability System](./provider-capability-system.md)
- [Testing Strategy](./testing-strategy.md)

## Current implementation and Phase 4 boundary

V2 is wired into the production [server](../../apps/server/src/server.ts) through
its [runtime layer](../../apps/server/src/orchestration-v2/runtimeLayer.ts), and
[WebSocket handlers](../../apps/server/src/ws.ts) dispatch through it. It is not
an unimplemented prerequisite to the Enterprise workflow.

The existing foundation includes transactional event/projection/receipt/outbox
persistence, worker retry/cancellation policies, provider runtime recovery,
thread forks, context handoff, runtime requests, and merge-back. Recovery coverage
includes rebuilding the orchestrator against durable storage with replayed
provider transports. This does not establish live-provider compatibility or
recovery for Enterprise operations that have not been implemented.

For traceable links between existing services, tests, and proposed Enterprise
work, see the [Blueprint implementation evidence](../T3_Code_Enterprise_Blueprint_v3_MVP.md#implementation-evidence)
and [integration map](../T3_Code_Enterprise_Blueprint_v3_MVP.md#implementation-map).

Remaining Enterprise work belongs in
[Blueprint Phase 4](../T3_Code_Enterprise_Blueprint_v3_MVP.md#phase-4-v2-enterprise-recovery):
TaskSpec/AgentHandoff/Evidence/RiskDecision persistence, task-stage recovery,
approval revalidation, remote PR reconciliation, and adversarial execution tests.
The [Enterprise contracts and evidence validator](../T3_Code_Enterprise_Blueprint_v3_MVP.md#initial-implementation-contracts-and-evidence-verification), owned workspace/check/gate services and CLI issue import exist. [Role launch/release](../../apps/server/src/enterprise/EnterpriseRoleService.ts) now uses V2 threads, runs, stable command identities and existing receipts/outbox. Native profile/configuration and scoped service tests passed; two supervised QA-backed correction rounds now reuse the same V2 boundaries. Persisted gate failures can now start the next bounded correction through `gateAndContinue`. A [workflow advance RPC](../T3_Code_Enterprise_Blueprint_v3_MVP.md#v2-workflow-advance) now reconciles the next stage from V2 projections. [Opt-in background automation](../T3_Code_Enterprise_Blueprint_v3_MVP.md#background-workflow-automation) now uses the existing scheduler, persisted configuration and V2 event sequences. [Explicit workflow cancellation](../T3_Code_Enterprise_Blueprint_v3_MVP.md#workflow-cancellation) persists disabled intent before issuing existing V2 Stop commands, and retries partial dispatch with stable identities. Stop acknowledgement does not prove provider termination. The full native Issue-to-PR pipeline, approvals, hard-crash drills and PR reconciliation remain incomplete. V2's existing delegated tasks and thread PR links
do not by themselves implement the full Issue-to-PR workflow.

Introduce operation identity, durable transitions and authorization with the
Phase 1/2 task runner and external integrations. Phase 4 hardens and verifies
those paths; it must not postpone their correctness until after implementation.

## Primary Goals

- Preserve provider-native lifecycle fidelity without leaking provider ids into app identity.
- Model root turns, subagents, tools, approvals, plans, and checkpoints as one execution graph.
- Make root-run completion the only event that completes a user-visible turn.
- Support forking from normal threads and completed subagent/provider threads.
- Support changing providers between runs as a first-class context handoff.
- Model forks, provider handoffs, merge-back, and subagents through shared thread lineage and context transfer primitives.
- Support providers with weak or missing ids through deterministic app-owned id allocation.
- Make feature behavior capability-driven, not provider-name-driven.

## Key Invariants

1. App ids are primary. Provider ids are refs.
2. Provider events are never rewritten to look like another provider event.
3. Child execution completion never closes the parent run.
4. Checkpoints attach to checkpointable execution scopes. Root-run checkpoints advance app run history; child/subagent checkpoints are nested and do not advance the parent run count.
5. Rollback is expressed in app run count and reconciled with provider conversation state.
6. Every command targets app ids; adapters translate to provider refs at the edge.
7. Missing provider capability is represented explicitly and handled by policy.
8. Provider switches create explicit context handoff artifacts; they are not hidden prompt hacks.
9. Forks record app-level lineage first. Provider-native forks and portable context handoffs are lazy resolution strategies chosen when a run starts.
10. Tests should prefer replay-backed integration coverage over mocked unit tests. The only normal substitute in orchestration tests is the provider runtime transport.

## Conceptual Layers

```text
Native provider protocol
  -> Rotating raw provider diagnostics
  -> Provider adapter / normalizer
  -> V2 orchestration event store using existing persistence patterns
  -> Runtime execution graph
  -> Conversation projection
  -> UI / API views
```

Raw provider diagnostics store what the provider actually sent or received for debugging and replay capture. The durable app state is the normalized orchestration state: events/entities, correlation refs, projections, and command receipts. The runtime graph stores what provider behavior means. The conversation projection stores what users see.

V2 should integrate with the existing orchestration command/event/projection infrastructure patterns rather than creating an unrelated event system. The V2-specific work is the graph model, provider lifecycle semantics, adapter contracts, normalizers, policies, and projections.

V2 owns its event schema. The V1 command and event unions are gone; V1 rows survive only as input to the legacy importer (`apps/server/src/orchestration-v2/legacy/`), and project events keep their own application event shape.

## Minimal Mental Model

```text
AppThread
  Run 1
    root ExecutionNode
      tool ExecutionNode
      approval ExecutionNode
      subagent ExecutionNode
        ProviderThread
          child root ExecutionNode
  Run 2
    root ExecutionNode
```

An app thread is the user-visible conversation. A run is the counted user-visible turn. Execution nodes are the tree of work inside the run. Provider threads are provider-native conversation handles that can be attached to app threads or nested execution nodes.

Provider switches do not create new app threads. They create or reactivate provider threads and attach context handoff summaries to the next run.

Forks do create new app threads, but they should not force provider selection at fork time. Forking records thread lineage and a pending source point. The first run on the fork resolves that source point through native provider fork when possible or portable context transfer when needed.

## Probe-Derived Requirements

The Codex app-server probes showed several protocol realities that the V2 model must preserve:

- `thread/status/changed` can become idle before or around completion, but `turn/completed` is the authoritative turn terminal event.
- `turn/interrupt` completes as a request first; the interrupted terminal state arrives later through `turn/completed`.
- Approval requests are provider-initiated JSON-RPC requests scoped to provider thread, turn, and item.
- `thread/rollback` returns an authoritative provider thread snapshot after rollback.
- Subagent child `turn/completed` events can occur before the parent/root turn completes.
- Child provider turns are real provider turns and must not be remapped onto the parent provider turn id.

These observations are why V2 separates app runs, provider turns, and execution nodes.

## Existing Platform Boundaries

V2 should reuse existing app infrastructure where that infrastructure is not the source of the orchestration bug class:

- Command dispatch should keep the existing serialized/idempotent command handling and command receipt pattern.
- Projection streams should keep the existing snapshot-plus-cursor semantics used by the current API.
- Persistence should keep the existing SQLite/migration/repository infrastructure and projection-stream semantics.
- Raw provider frames should continue to be diagnostic log data, with bounded retention through rotating logs.
- Replay tests should replace only the provider transport/process boundary.

V2 may add V2-native orchestration events, projection tables, command policies, and provider execution services. It should not add a durable raw-provider-event database or a separate generic event bus unless the existing infrastructure cannot satisfy a documented V2 requirement.

V2 command dispatch returns the last committed stored-event sequence for accepted commands. Duplicate command ids must return the same receipt-backed result without re-running provider side effects. This is the API-level boundary the frontend uses for reconnect/recovery cursors.

## Durable Effect Outbox — Implemented

The current V2 server records orchestration intent before performing side effects.
[EventSink](../../apps/server/src/orchestration-v2/EventSink.ts) commits events,
persisted projections, the command receipt, and
[outbox effects](../../apps/server/src/orchestration-v2/EffectOutbox.ts) in one
transaction. It publishes committed events afterward. A repeated command id
returns its stored receipt instead of enqueuing the command's effects again.

```text
command
  -> transaction:
       append orchestration events
       update persisted projections
       record command receipt
       enqueue effects
  -> publish committed events to subscribers

effect worker
  -> claim an eligible effect
  -> perform external work after commit
  -> feed results back through orchestration commands
  -> settle the effect or apply its retry/recovery policy
```

The [effect worker](../../apps/server/src/orchestration-v2/EffectWorker.ts) runs
provider and other orchestration side effects after commit. A command
acknowledgement confirms durable intent; it does not confirm that external work
has finished.

### Recovery boundary

A transactional outbox does not guarantee exactly-once external execution. A
process can fail after a remote operation succeeds but before its result is
persisted. Retrying that operation may duplicate a PR, deployment, or database
write. Each integration needs a stable operation identity and a way to reconcile
an uncertain outcome, or an explicit manual recovery path. Effects bound to a
lost provider process cannot simply replay; follow the existing
[provider runtime recovery](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
policy.

### Enterprise extension boundary

Enterprise task stages, handoff artifacts, evidence, budgets, and approval rules
belong to application services above V2. They reuse its command receipts,
event persistence, projections, outbox, provider adapters, and checkpoints. They
must not introduce a parallel orchestration ledger, generic event bus, or outbox.
The current [Enterprise role service](../../apps/server/src/enterprise/EnterpriseRoleService.ts)
launches roles through V2 and derives `AgentHandoff` from a completed run's ready
checkpoint, resolving its Git ref rather than trusting the current HEAD or agent
prose. It reuses persisted checkpoint IDs and creates no second commit, execution
ledger, or artifact store. Structured Architect specs and QA reports reuse the final
persisted assistant message identity and validate task, commit, criteria coverage
and checkpoint file trees. They remain untrusted descriptions, not test results
or approvals; see the [Blueprint implementation status](../T3_Code_Enterprise_Blueprint_v3_MVP.md#implementation-evidence). `enterprise.gateRole` checks that checkpoint in a separate detached checkout while
preserving the agent checkout. `enterprise.buildPullRequestDraft` verifies the scoped
gate artifact against V2 before rendering evidence; it does not publish or authorize
a PR. Up to two [supervised correction rounds](../T3_Code_Enterprise_Blueprint_v3_MVP.md#supervised-correction-rounds) use stable role-thread identities and explicit revision selection for handoff, QA, gate and draft evidence. [Gate-failure continuation](../T3_Code_Enterprise_Blueprint_v3_MVP.md#persisted-gate-failure-continuation) reuses scoped failure artifacts and those same correction identities. [Workflow advance](../T3_Code_Enterprise_Blueprint_v3_MVP.md#v2-workflow-advance) coordinates those services from persisted V2 state with an immutable configuration digest on workspace ownership. Manual advance remains available; registered background workflows use the shared scheduler after run/checkpoint sequence changes, revalidate their owner session and stop at draft/manual-review boundaries. Native Issue-to-PR acceptance and hard-crash drills remain incomplete.
Extend existing contracts and persistence only for a demonstrated task-domain gap,
while keeping provider and filesystem I/O outside command decisions and database
transactions.

Task transitions and approval decisions need durable authorization and operation
identity. PR creation needs reconciliation with the remote repository before a
retry; command deduplication alone cannot prevent duplicate remote writes. Verify
restart, reconnect, cancellation, duplicate commands, and the failure window
between external success and local settlement before claiming safe recovery.
