# Enterprise Phase 4: server restart drills (17 October 2026)

This is the evidence for the Phase 4 crash, restart and reconnect drills. It comes from one live run of [`verify-enterprise-restart-drill.ts`](../../../apps/server/scripts/verify-enterprise-restart-drill.ts) with `--server source`.

The run used real Codex `gpt-6.1-sol` turns and the local calculator fixture with a read-only fake `gh`, so nothing was written to GitHub. Each scenario `SIGKILL`s the server's whole process group, including provider children, then restarts the server on the same T3 home. After each restart it pairs a **new** session from a new bootstrap token, which is the reconnect path.

| Scenario         | Crash point                                                          | Result after restart                                                                                                                                    | Duplicate check                                                               |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `between-stages` | Coder run completed with a ready checkpoint, before the next advance | `enterprise.advanceWorkflow` continued (QA, then gate) to `ready`. A repeated advance returned `ready` with the same verified commit                    | Architect, Coder and QA threads each have exactly one run, the `:initial` run |
| `mid-turn`       | Coder run `running`                                                  | `blocked` with `failed_run`, and the same again on a repeated advance. The lost provider turn is not replayed, and work stops for manual reconciliation | The Coder thread keeps its single original run. No QA thread was created      |

[`restart-drill-verdict.json`](./restart-drill-verdict.json) holds the per-thread run counts and IDs. The first attempt failed inside the harness itself: it killed the server while its own RPC client still held the socket. The supervisor fixed the kill ordering and reran the drill. That first failure was not a server outcome.

## Related Phase 4 evidence

- **Crash after a remote PR create, before local settlement:** [publication crash drill](../../../apps/server/src/enterprise/EnterprisePublicationCrash.test.ts) (real process exit, fake `gh`) and the [live duplicate publish](../enterprise-phase2-acceptance-2026-10-17/README.md), which reconciled to the same PR.
- **Duplicate commands and cancellation:** V2 command receipts, plus cancellation integration fixtures in [`EnterpriseRoleService.test.ts`](../../../apps/server/src/enterprise/EnterpriseRoleService.test.ts). These are service-level fixtures, not a live cancel during a gate.

## Limits

These are single live runs on a one-line fixture. They demonstrate the recovery semantics, not their reliability under load.
