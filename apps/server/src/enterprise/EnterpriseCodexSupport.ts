import { CodexSettings, type ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";

// Profiles and native deny-read behavior are verified against this CLI version.
// Custom executable/home/arguments need their own probes before joining this MVP.
export const ENTERPRISE_CODEX_VERSION = "codex-cli 0.162.1";

/**
 * Only an unmodified default install is supported. `binaryPath === "codex"` is what makes probing
 * `codex` from PATH equivalent to probing the configured binary.
 */
export function isDefaultEnterpriseCodexConfig(config: CodexSettings): boolean {
  return (
    config.binaryPath === "codex" &&
    config.homePath === "" &&
    config.shadowHomePath === "" &&
    config.launchArgs === "" &&
    config.setupMode !== "managed"
  );
}

/** Facts about the host Codex install that the named Enterprise profile depends on. */
export interface EnterpriseCodexInstallation {
  /** Every configured MCP server; role threads disable them all, plus T3's own. */
  readonly mcpServerNames: ReadonlyArray<string>;
  /** The npm package directory, granted read-only so Codex can run inside its own sandbox. */
  readonly toolchainRoot: string;
}

/** The provider or host is outside the verified MVP envelope. Callers fail closed. */
export class EnterpriseCodexUnsupported extends Data.TaggedError("EnterpriseCodexUnsupported")<{
  readonly cause?: unknown;
}> {}

const decodeCodexConfig = Schema.decodeUnknownEffect(CodexSettings);
const decodeMcpNames = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(256)) })).check(
      Schema.isMaxLength(256),
    ),
  ),
);

/** Successful host probes are reused briefly; failures are retried on the next call. */
const PROBE_TTL = "1 minute";

/**
 * Builds a probe shared by role launch and runtime policy. Process-spawning checks are cached so
 * resolving a policy per turn does not run `codex` twice per turn.
 */
export const makeEnterpriseCodexProbe = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unsupported = (cause?: unknown) => new EnterpriseCodexUnsupported({ cause });
  const asUnsupported = (cause: unknown) =>
    cause instanceof EnterpriseCodexUnsupported ? cause : unsupported(cause);

  const cacheSuccess = <A, E>(probe: Effect.Effect<A, E>) =>
    Effect.cachedWithTTL(probe, (exit) => (Exit.isSuccess(exit) ? PROBE_TTL : 0));

  const version = yield* cacheSuccess(
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") return yield* unsupported("platform");
      const output = yield* runner.run({
        command: "codex",
        args: ["--version"],
        timeout: "5 seconds",
        maxOutputBytes: 4096,
      });
      if (output.code !== 0 || output.stdout.trim() !== ENTERPRISE_CODEX_VERSION)
        return yield* unsupported("version");
    }).pipe(Effect.mapError(asUnsupported)),
  );

  const installation = yield* cacheSuccess(
    Effect.gen(function* () {
      const mcp = yield* runner.run({
        command: "codex",
        args: ["mcp", "list", "--json"],
        timeout: "5 seconds",
        maxOutputBytes: 1_048_576,
      });
      if (mcp.code !== 0) return yield* unsupported("mcp_list");
      const names = yield* decodeMcpNames(mcp.stdout);
      // The Linux/npm MVP grants the installed Codex package, not the user's home.
      // Other installation layouts fail closed until they have a tested resolver.
      const toolchainRoot = yield* fs.realPath(
        path.join(
          path.dirname(yield* HostProcess.ExecutablePath),
          "../lib/node_modules/@openai/codex",
        ),
      );
      return {
        mcpServerNames: names.map((server) => server.name),
        toolchainRoot,
      } satisfies EnterpriseCodexInstallation;
    }).pipe(Effect.mapError(asUnsupported)),
  );

  /** Default Codex driver config on Linux with the pinned CLI version; enough to launch a role. */
  const checkVersion = Effect.fn("EnterpriseCodexProbe.checkVersion")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: string | undefined;
  }) {
    if (input.driverKind !== "codex") return yield* unsupported("driver");
    const config = yield* settings.getSettings.pipe(
      Effect.flatMap((current) =>
        decodeCodexConfig(current.providerInstances[input.instanceId]?.config ?? {}),
      ),
      Effect.mapError(unsupported),
    );
    if (!isDefaultEnterpriseCodexConfig(config)) return yield* unsupported("config");
    yield* version;
  });

  /** `checkVersion` plus the install facts the named runtime profile needs. */
  const check = Effect.fn("EnterpriseCodexProbe.check")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: string | undefined;
  }) {
    yield* checkVersion(input);
    return yield* installation;
  });
  return { checkVersion, check };
});

export type EnterpriseCodexProbe = Effect.Success<typeof makeEnterpriseCodexProbe>;
