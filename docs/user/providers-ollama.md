# Ollama

Ollama runs models on your own machine. It is a model server, not a coding agent: it has no
tool loop, sandbox, or approvals. T3 Code therefore uses Ollama models through
[OpenCode](./providers-opencode.md), which supplies the agent, tools, and approval flow.

## Set up

1. Install and start [Ollama](https://ollama.com), then pull a model, for example
   `ollama pull qwen2.5-coder:14b`.
2. Install OpenCode and tell it about Ollama's OpenAI-compatible endpoint in
   `~/.config/opencode/opencode.json`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "ollama": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Ollama (local)",
         "options": { "baseURL": "http://localhost:11434/v1" },
         "models": { "qwen2.5-coder:14b": { "name": "Qwen2.5 Coder 14B" } }
       }
     }
   }
   ```

   List each model you want under `models`; OpenCode does not discover them from Ollama.

3. Enable OpenCode in **Settings > Providers** and refresh its status. The model picker then
   shows `ollama/<model>` entries next to OpenCode's other models.

## What to expect

- Locally hosted Ollama models run inference on your machine. Cloud-backed Ollama models,
  OpenCode's other providers and enabled integrations can use remote services. Choose the model per thread.
- Local models are slower and weaker at tool use than hosted ones. Pick a model with tool
  support, and use a larger one for multi-file edits.
- Token usage is reported by Ollama. Enterprise cost reporting treats a model you price at zero
  as free; a model without a price is reported as unpriced, not free. See the
  [Enterprise cost report](../T3_Code_Enterprise_Blueprint_v3_MVP.md).
- Enterprise workflows can use local Ollama through the Codex agent loop and its existing
  permission profile. Regular OpenCode threads continue using the setup above.

## Enterprise local routing

The Linux MVP requires Codex CLI 0.162.1 and an installed, tool-capable local model.
Use `instanceId: "codex"` and `model: "ollama/qwen3-coder:30b"` in a routing candidate.
The server probes `http://127.0.0.1:11434/api/show`, refuses cloud-backed models, and sends
inference through a fixed loopback Responses endpoint. Tools keep the same filesystem and
network restrictions used for cloud Codex roles. Plugins, hooks and native collaboration
are disabled at startup as well as at thread creation.

Add routing to an `enterprise.startWorkflow` or `enterprise.startIssueWorkflow` request:

```json
{
  "routing": {
    "candidates": [
      { "selection": { "instanceId": "codex", "model": "your-cloud-model" }, "tier": "cloud" },
      { "selection": { "instanceId": "codex", "model": "ollama/qwen3-coder:30b" }, "tier": "local" }
    ],
    "preferLocalDocs": true,
    "allowCloudFallback": false
  }
}
```

Configure `enterprise-pricing.json` in the environment's state directory with prices for
all candidates first. Missing prices block routed work. A local zero rate is an explicit
choice and excludes hardware and electricity costs. Architect and QA use cloud; only a
validated documentation-only Coder plan qualifies for local execution. Source code changes
in a local documentation checkpoint are rejected. Models can fail formatting or tool-use
requirements; deterministic checks and structured output validation still decide readiness.

Provider retries are bounded to two per role and stay on the same inference backend. Partial
work or unknown spend requires intervention. Local-to-cloud fallback applies only before a
role starts, and requires `allowCloudFallback: true`.

Run the opt-in native fixtures from the repository root:

```sh
T3_ENTERPRISE_LIVE_OLLAMA=1 T3_ENTERPRISE_ACCEPTANCE_ROOT=/absolute/writable/scratch \
  vp test run apps/server/src/enterprise/EnterpriseOllama.live.test.ts \
  --reporter=json --outputFile=/absolute/writable/scratch/ollama-results.json
```

The scratch directory must already exist outside the source checkout; avoid `/tmp` for native
Codex helper aliases. Fixtures create and remove a disposable home, use no subscription
credentials, and check inference, scoped reads, synthetic host-secret denial and documentation
writes, exact-content document correction and consistency across two documents. The native fixture uses `qwen3-coder:30b`; install it before running.

The configuration follows [Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[Ollama's Codex integration](https://docs.ollama.com/integrations/codex).

### Compare with the account's cloud model

The same five fixtures can run on cloud with explicit opt-in. The fixture queries the account
model catalog and uses its default, or exactly `T3_ENTERPRISE_CLOUD_MODEL` if supplied. It copies
`auth.json` into a disposable home and removes that copy on completion; the source credential
is never written. `T3_ENTERPRISE_CLOUD_AUTH_FILE` can choose a different source credential file.
Only synthetic fixture content is sent for inference.

```sh
T3_ENTERPRISE_BENCHMARK_BACKEND=cloud T3_ENTERPRISE_LIVE_CLOUD=1 \
  T3_ENTERPRISE_ACCEPTANCE_ROOT=/absolute/writable/scratch \
  T3_ENTERPRISE_BENCHMARK_REPEAT=3 \
  T3_ENTERPRISE_BENCHMARK_REPORT_ROOT=/absolute/writable/scratch/measurements \
  vp test run apps/server/src/enterprise/EnterpriseOllama.live.test.ts \
  --reporter=json --outputFile=/absolute/writable/scratch/cloud-results.json
```

Set the same report directory for the local command to retain both sets of per-fixture
measurements. Reports include pass/fail, selected model, elapsed time, token usage and
API-equivalent cents. Unknown usage/pricing, cache writes and unsupported long-context pricing
produce unknown cost. The fixture's sampled standard rates for GPT-5.5 and GPT-6.1 Sol are
sourced from their official model pages and are not production defaults. Actual subscription
charges and local hardware/electricity remain unknown. One run per fixture is a smoke comparison,
not a statistical model-quality or cost-savings claim.

For a comparison, use `T3_ENTERPRISE_BENCHMARK_REPEAT=3` and the same fresh measurements
directory on both backends. Each of five cases runs three times. The fixture refuses to
overwrite previous sample files. Summarize all planned samples, including failures:

```sh
node apps/server/scripts/summarize-enterprise-benchmark.ts /absolute/writable/scratch/measurements 3
```

The summary refuses missing samples, invalid measurements or mixed prompt versions. Treat
failed exact-content or extra-file checks as failures even when the model reports success.
The shared Coder instructions require final-file inspection and cleanup of temporary artifacts;
this improves reliability but does not replace QA and deterministic gates.

### Verify the complete workflow locally

After building the server, run the headless acceptance harness from the repository root:

```sh
node apps/server/scripts/verify-enterprise-live.ts --scratch /absolute/writable/scratch --scenario docs
node apps/server/scripts/verify-enterprise-live.ts --scratch /absolute/writable/scratch --scenario code
```

Run these sequentially. The fixture pins `gpt-6.1-sol` and its explicit API-equivalent price
assumptions; the docs scenario also needs local `qwen3-coder:30b`. It starts a disposable server,
authenticates a client, imports a local Issue fixture through the real importer, launches real
V2 roles, checks their actual model selections, waits for persisted checkpoints and executes
sandboxed checks before accepting a draft. A repeated advance must remain ready. It retains
a verdict, draft and synthetic repository/worktree evidence, then removes the temporary server
home. Source authentication is never modified. It opens no browser and creates no GitHub
resources. This verifies the local Issue-to-draft path; remote publication requires a separate
explicitly authorized GitHub acceptance run.
