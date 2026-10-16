import { EnterpriseRoleError, type EnterpriseLaunchRoleInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  codexNativeModel,
  isCodexLocalModel,
} from "../orchestration-v2/Adapters/CodexNamedProfile.ts";
import type * as ProcessRunner from "../processRunner.ts";
import type * as Providers from "../provider/ProviderInstanceRegistry.ts";
import type { EnterpriseCodexProbe } from "./EnterpriseCodexSupport.ts";

/** Loopback only, matching the named Codex profile's provider route. */
const OLLAMA_SHOW_URL = "http://127.0.0.1:11434/api/show";
const OLLAMA_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,200}$/;
/** Ollama "cloud" tags proxy prompts to a remote service; a local role must never use them. */
const OLLAMA_CLOUD_TAG = /(?:^|[-:])cloud(?:$|[-:])/i;

const encodeOllamaProbe = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
);
const decodeOllamaDetails = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      capabilities: Schema.Array(Schema.String),
      remote_model: Schema.optional(Schema.String),
      remote_host: Schema.optional(Schema.String),
    }),
  ),
);

/**
 * Builds the pre-launch model check. Only the default `codex` instance at the pinned CLI version
 * is supported. A local `ollama/` model must be a tool-capable model served from this host:
 * cloud-tagged or remote-backed models are refused, so a "local" route cannot leak context.
 */
export const makeValidateRoleModel = (deps: {
  readonly codex: EnterpriseCodexProbe;
  readonly providers: Providers.ProviderInstanceRegistry["Service"];
  readonly runner: ProcessRunner.ProcessRunner["Service"];
}) =>
  Effect.fn("EnterpriseRoleService.validateModel")(function* (
    modelSelection: EnterpriseLaunchRoleInput["modelSelection"],
  ) {
    if (modelSelection.instanceId !== "codex")
      return yield* new EnterpriseRoleError({ reason: "provider_unsupported" });
    const instance = yield* deps.providers.getInstance(modelSelection.instanceId);
    yield* deps.codex
      .checkVersion({ instanceId: modelSelection.instanceId, driverKind: instance?.driverKind })
      .pipe(
        Effect.mapError(
          (cause) => new EnterpriseRoleError({ reason: "provider_unsupported", cause }),
        ),
      );
    if (!isCodexLocalModel(modelSelection.model)) return;
    const model = codexNativeModel(modelSelection.model);
    if (!OLLAMA_MODEL_NAME.test(model) || OLLAMA_CLOUD_TAG.test(model))
      return yield* new EnterpriseRoleError({ reason: "provider_unsupported" });
    const probe = yield* deps.runner.run({
      command: "/usr/bin/curl",
      args: [
        "--noproxy",
        "*",
        "--max-time",
        "5",
        "--silent",
        "--show-error",
        "--fail",
        "--json",
        yield* encodeOllamaProbe({ model }),
        OLLAMA_SHOW_URL,
      ],
      timeout: "6 seconds",
      maxOutputBytes: 65_536,
    });
    const details = yield* decodeOllamaDetails(probe.stdout).pipe(
      Effect.mapError(
        (cause) => new EnterpriseRoleError({ reason: "provider_unsupported", cause }),
      ),
    );
    if (
      probe.code !== 0 ||
      probe.stdoutTruncated ||
      probe.stdoutInvalidUtf8 ||
      probe.timedOut ||
      details.remote_model ||
      details.remote_host ||
      !details.capabilities.includes("tools")
    )
      return yield* new EnterpriseRoleError({ reason: "provider_unsupported" });
  });
