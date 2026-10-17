# Enterprise Phase 3: scoped cloud/local benchmark (17 October 2026)

These are the raw per-sample results behind the Phase 3 numbers in the [Blueprint](../../T3_Code_Enterprise_Blueprint_v3_MVP.md). Every planned sample is kept, including failures.

[`summarize-enterprise-benchmark.test.ts`](../../../apps/server/scripts/summarize-enterprise-benchmark.test.ts) recomputes the published figures from these files. If the samples or the published numbers change without the other, that test fails.

## What was measured

- **Fixtures:** five native Coder fixtures (`inference`, `workspace_read`, `docs_write`, `docs_revision`, `docs_consistency`), run three times per backend.
- **Cloud:** `gpt-6.1-sol` through Codex.
- **Local:** `ollama/qwen3-coder:30b` through the same Codex agent loop and named permission profile.
- **Grading:** the same rubric for both backends. A failure on exact content or on an extra file counts as a failure even when the model reports success.

| Prompt | Backend | Passed | Median elapsed | API-equivalent cost | Fixtures below 3/3 (passed)                                        |
| ------ | ------- | ------ | -------------- | ------------------- | ------------------------------------------------------------------ |
| v2     | cloud   | 15/15  | 8.53 s         | USD 0.53            | none                                                               |
| v2     | local   | 13/15  | 6.78 s         | 0 (assumed)         | `docs_revision` 1/3: formatting changed outside the requested edit |
| v1     | cloud   | 15/15  | 10.68 s        | USD 0.45            | none                                                               |
| v1     | local   | 11/15  | 5.80 s         | 0 (assumed)         | `docs_revision` 0/3, `docs_consistency` 2/3                        |

The v1 results are the first prompt version. They are kept as separate evidence rather than overwritten by v2.

## Host

| Component | Value                                                       |
| --------- | ----------------------------------------------------------- |
| CPU       | Intel Core i7-11700 (16 threads)                            |
| RAM       | 31 GiB                                                      |
| GPU       | 3 × NVIDIA GeForce RTX 3060 (12 GiB each), driver 595.91.07 |
| Software  | Ollama 0.40.4, Codex CLI 0.162.1, Linux                     |

The host details were recorded when the evidence was committed. The samples do not record hardware themselves.

## Limits

- These are synthetic, documentation-scoped tasks. They do not establish a general coding pass rate, production readiness or overall cost savings.
- Cloud cost is a sum of rounded, per-turn API-equivalent prices at short-context rates. Actual subscription charges are unknown.
- Local cost of zero is an accounting assumption. GPU, electricity and hardware costs are excluded.
- The results support only the explicit opt-in, documentation-only local route, with cloud Architect/QA and deterministic gates.

## Reproduce

To recompute a summary from the committed samples:

```bash
node apps/server/scripts/summarize-enterprise-benchmark.ts docs/benchmarks/enterprise-phase3-2026-10-17/prompt-v2 3
```

To collect new samples, see [Ollama setup and acceptance commands](../../user/providers-ollama.md).
