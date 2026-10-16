import * as ServerSettings from "../serverSettings.ts";
import { CodexSettings } from "@t3tools/contracts";
import {
  ENTERPRISE_CODEX_VERSION,
  isDefaultEnterpriseCodexConfig,
} from "../enterprise/EnterpriseCodexSupport.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    }),
});

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having T3 imitate it.
 */
function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

const decodeCodexConfig = Schema.decodeUnknownEffect(CodexSettings);
const decodeMcpNames = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(256)) })).check(
      Schema.isMaxLength(256),
    ),
  ),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner.ProcessRunner
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const runner = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        if (
          /^enterprise:[a-f0-9]{64}:(?:fix[12]:)?(?:architect|coder|qa)$/.test(input.thread.id) &&
          (instance?.driverKind !== "codex" || input.thread.worktreePath === null)
        )
          return yield* new RuntimePolicyResolveError({
            projectId: input.thread.projectId,
            providerInstanceId: input.modelSelection.instanceId,
          });
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        const enterprise = /^enterprise:[a-f0-9]{64}:(?:fix[12]:)?(?:architect|coder|qa)$/.test(
          input.thread.id,
        );
        let readonlyToolchainRoots: ReadonlyArray<string> = [];
        let disabledMcpServerNames: ReadonlyArray<string> = [];
        if (enterprise) {
          if ((yield* HostProcess.Platform) !== "linux")
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
            });
          const config = yield* decodeCodexConfig(
            (yield* settings.getSettings.pipe(
              Effect.mapError(
                (cause) =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                    cause,
                  }),
              ),
            )).providerInstances[input.modelSelection.instanceId]?.config ?? {},
          ).pipe(
            Effect.mapError(
              () =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                }),
            ),
          );
          const version = yield* runner
            .run({
              command: "codex",
              args: ["--version"],
              timeout: "5 seconds",
              maxOutputBytes: 4096,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                  }),
              ),
            );
          if (
            !isDefaultEnterpriseCodexConfig(config) ||
            version.code !== 0 ||
            version.stdout.trim() !== ENTERPRISE_CODEX_VERSION
          )
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
            });
          const mcp = yield* runner
            .run({
              command: "codex",
              args: ["mcp", "list", "--json"],
              timeout: "5 seconds",
              maxOutputBytes: 1_048_576,
            })
            .pipe(
              Effect.mapError(
                () =>
                  new RuntimePolicyResolveError({
                    projectId: input.thread.projectId,
                    providerInstanceId: input.modelSelection.instanceId,
                  }),
              ),
            );
          if (mcp.code !== 0)
            return yield* new RuntimePolicyResolveError({
              projectId: input.thread.projectId,
              providerInstanceId: input.modelSelection.instanceId,
            });
          const names = yield* decodeMcpNames(mcp.stdout).pipe(
            Effect.mapError(
              () =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                }),
            ),
          );
          disabledMcpServerNames = [...new Set(["t3-code", ...names.map((server) => server.name)])];
          // The Linux/npm MVP grants the installed Codex package, not the user's home.
          // Other installation layouts fail closed until they have a tested resolver.
          readonlyToolchainRoots = [
            yield* fs
              .realPath(
                path.join(
                  path.dirname(yield* HostProcess.ExecutablePath),
                  "../lib/node_modules/@openai/codex",
                ),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause,
                    }),
                ),
              ),
          ];
        }
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(input.thread.runtimeMode, supportedRuntimeModes),
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(enterprise
            ? {
                disableT3Mcp: true,
                approvalPolicy: "never",
                filesystemAccess: input.thread.id.endsWith(":coder") ? "write" : "read",
                readonlyToolchainRoots,
                disabledMcpServerNames,
              }
            : {}),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
