import * as ServerSettings from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    driverKind: instanceId === providerInstanceId ? "codex" : "grok",
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
  ),
  Layer.provide(
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Effect.succeed({
          code: 0,
          stdout: input.args?.[0] === "--version" ? "codex-cli 0.162.1" : '[{"name":"host-tool"}]',
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } as ProcessRunner.ProcessRunOutput),
    }),
  ),
  Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            autoPull: false,
            faviconPath: null,
            projectIcon: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("enforces enterprise role permissions even when the thread requests full access", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      for (const role of [
        "architect",
        "coder",
        "qa",
        "fix1:coder",
        "fix1:qa",
        "fix2:coder",
        "fix2:qa",
      ]) {
        const thread = {
          ...makeThread({ now, worktreePath: "/task/worktree", runtimeMode: "full-access" }),
          id: ThreadId.make(`enterprise:${"a".repeat(64)}:${role}`),
        };
        const resolved = yield* policy.resolve({ thread, modelSelection });
        assert.equal(resolved.approvalPolicy, "never");
        assert.equal(resolved.disableT3Mcp, true);
        assert.equal(resolved.sandboxPolicy, undefined);
        assert.equal(resolved.filesystemAccess, role.endsWith("coder") ? "write" : "read");
        assert.equal(resolved.readonlyToolchainRoots?.length, 1);
        assert.deepEqual(resolved.disabledMcpServerNames, ["t3-code", "host-tool"]);
      }
    }),
  );
  it.effect("refuses enterprise roles after a switch to an unsupported provider", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = {
        ...makeThread({ now, worktreePath: "/task/worktree" }),
        id: ThreadId.make(`enterprise:${"a".repeat(64)}:coder`),
      };
      const error = yield* policy
        .resolve({ thread, modelSelection: { ...modelSelection, instanceId: grokInstanceId } })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyResolveError");
    }),
  );
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});
