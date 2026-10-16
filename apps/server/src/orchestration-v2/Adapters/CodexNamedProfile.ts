/**
 * Codex settings for threads that run under a named, deny-by-default permission profile
 * (`ProviderAdapterV2RuntimePolicy.filesystemAccess`), plus the loopback Ollama model route those
 * threads may use. Lives beside the adapter so policy owners (for example Enterprise) depend on
 * core, never the reverse.
 */

/** Model IDs with this prefix run on the local Ollama Responses endpoint, not OpenAI. */
export const CODEX_LOCAL_MODEL_PREFIX = "ollama/";

export const isCodexLocalModel = (model: string) => model.startsWith(CODEX_LOCAL_MODEL_PREFIX);

/** The model name Codex/Ollama expects, without T3's routing prefix. */
export const codexNativeModel = (model: string) =>
  isCodexLocalModel(model) ? model.slice(CODEX_LOCAL_MODEL_PREFIX.length) : model;

export const CODEX_LOCAL_MODEL_PROVIDER = "t3-ollama";

/** Loopback only: a named-profile thread must not reach a remote host through this provider. */
export const CODEX_LOCAL_MODEL_PROVIDER_CONFIG = {
  name: "Local Ollama",
  base_url: "http://127.0.0.1:11434/v1",
  wire_api: "responses",
  requires_openai_auth: false,
  supports_websockets: false,
  request_max_retries: 0,
  stream_max_retries: 0,
} as const;

/** Disable startup discovery too; thread overrides arrive after native initialization. */
export const CODEX_NAMED_PROFILE_STARTUP_ARGS = [
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  "features.hooks=false",
  "-c",
  "features.multi_agent=false",
  "-c",
  "features.goals=false",
] as const;
