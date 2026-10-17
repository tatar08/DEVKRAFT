# Enterprise Phase 2: live remote Issue-to-PR acceptance (17 October 2026)

This is the evidence for the Phase 2 exit criterion, "end-to-end demo on template repository". It comes from one live run against GitHub.

## What ran

| Item               | Value                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository         | `tatar08/t3-enterprise-demo` (private) — a calculator whose `add(a, b)` returned `a - b`, with `test_calc.py` failing                              |
| Issue              | #1 "Correct calculator addition", imported with the authenticated `gh` through `enterprise.startIssueWorkflow`                                     |
| Pipeline           | Architect → Coder → QA → deterministic gate, all through real V2 roles on Codex `gpt-6.1-sol`. QA passed on revision 0, so no correction round ran |
| Gate               | Four sandboxed checks (unittest, tab lint, syntax, secret scan) passed at the same commit, `71c874401181eb8d8980b459dad59c9c7556c7d9`              |
| Publication        | `enterprise.publishPullRequest` opened **draft PR #2** on the deterministic branch `enterprise/pr-<task>-<commit>`                                 |
| Duplicate-PR check | A second identical publish returned the same PR with `reconciled: true`. GitHub lists exactly one PR for that head branch                          |
| Elapsed            | About 40 seconds from the issue import to `ready`                                                                                                  |
| Cost               | USD 0.15 API-equivalent, from the configured price table. Not the actual subscription charge                                                       |

The supervisor then checked GitHub independently:

- PR #2 is a draft against `main`.
- It changes only `calc.py`, by one line (`return a + b`).
- `python3 -m unittest` passes on the PR head.
- The repository has exactly one PR.

## Files

- [`verdict.json`](./verdict.json): the harness verdict, including the stages, the model chosen per role and both publish results.
- [`draft.json`](./draft.json): the Proof-of-Work evidence and the PR body built from the server's gate artifact.

## Reproduce

To rerun against your own repository and issue:

```bash
node apps/server/scripts/verify-enterprise-live.ts --scratch /path/outside/tmp --remote OWNER/REPO --issue 1 --server source
```

## Limits

- This is one successful run on a one-line fixture. It is not a pass-rate benchmark.
- The issue was benign. Malicious-input and hard-crash drills belong to Phase 4.
- `approvalStatus` stays `not_evaluated`. Nothing was merged. Cost is reported only through the configured price table.
