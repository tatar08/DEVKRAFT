import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EnterpriseRuntimePolicy from "./EnterpriseRuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const grokInstanceId = ProviderInstanceId.make("grok");
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

const probes: Array<string> = [];
const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(EnterpriseRuntimePolicy.layer),
  Layer.provide(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
  ),
  Layer.provide(
    Layer.mock(ProcessRunner.ProcessRunner)({
      run: (input) =>
        Effect.sync(() => {
          probes.push(input.args?.join(" ") ?? "");
          return {
            code: 0,
            stdout:
              input.args?.[0] === "--version" ? "codex-cli 0.162.1" : '[{"name":"host-tool"}]',
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          } as ProcessRunner.ProcessRunOutput;
        }),
    }),
  ),
  Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed({
          driverKind: instanceId === providerInstanceId ? "codex" : "grok",
          snapshot: { getSnapshot: Effect.succeed({} as ServerProvider) },
        } as ProviderInstance),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
  ),
);

const roleThread = (now: DateTime.Utc, role: string, runtimeMode?: RuntimeMode) => ({
  ...makeThread({ now, worktreePath: "/task/worktree", ...(runtimeMode ? { runtimeMode } : {}) }),
  id: ThreadId.make(`enterprise:${"a".repeat(64)}:${role}`),
});

it.layer(layerTest)("EnterpriseRuntimePolicy", (it) => {
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
        const resolved = yield* policy.resolve({
          thread: roleThread(now, role, "full-access"),
          modelSelection,
        });
        assert.equal(resolved.approvalPolicy, "never");
        assert.equal(resolved.disableT3Mcp, true);
        assert.equal(resolved.sandboxPolicy, undefined);
        assert.equal(resolved.filesystemAccess, role.endsWith("coder") ? "write" : "read");
        assert.equal(resolved.readonlyToolchainRoots?.length, 1);
        assert.deepEqual(resolved.disabledMcpServerNames, ["t3-code", "host-tool"]);
      }
      // Seven resolves share one cached host probe instead of spawning codex per turn.
      assert.deepEqual(probes, ["--version", "mcp list --json"]);
    }),
  );
  it.effect("refuses enterprise roles after a switch to an unsupported provider", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({
          thread: roleThread(now, "coder"),
          modelSelection: { ...modelSelection, instanceId: grokInstanceId },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyResolveError");
    }),
  );
  it.effect("leaves ordinary threads untouched", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/task/worktree" }),
        modelSelection,
      });
      assert.isUndefined(resolved.filesystemAccess);
      assert.isUndefined(resolved.disableT3Mcp);
    }),
  );
});
