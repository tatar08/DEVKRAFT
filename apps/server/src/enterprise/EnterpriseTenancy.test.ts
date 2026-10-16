import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TaskSpec } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import * as Tenancy from "./EnterpriseTenancy.ts";

const decodeSpec = Schema.decodeUnknownSync(TaskSpec);
const spec = (tenantId: string) =>
  decodeSpec({
    taskId: "task:tenant",
    tenantId,
    projectId: "project:tenant",
    repoCommit: "a".repeat(40),
    acceptanceCriteria: ["Pass"],
    approvedTools: [],
    budgetLimit: { currency: "USD", limitCents: 100 },
  });

/** Runs `use` with a tenancy service backed by a real temp state directory. */
const withTenants = <A, E>(
  contents: string | undefined,
  use: (
    tenancy: Tenancy.EnterpriseTenancyShape,
    write: (contents: string) => Effect.Effect<void>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tenancy-test-" });
    const file = path.join(stateDir, Tenancy.TENANTS_FILE_NAME);
    const write = (value: string) => fs.writeFileString(file, value).pipe(Effect.orDie);
    if (contents !== undefined) yield* write(contents);
    const tenancy = yield* Tenancy.EnterpriseTenancy.pipe(
      Effect.provide(
        Tenancy.layer.pipe(
          Layer.provide(Layer.succeed(ServerConfig, { stateDir } as ServerConfig["Service"])),
        ),
      ),
    );
    return yield* use(tenancy, write);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const allowed = (tenancy: Tenancy.EnterpriseTenancyShape, tenantId: string) =>
  tenancy
    .authorize(tenantId)
    .pipe(
      Effect.as(true),
      Effect.catchTags({ EnterpriseTenantRejected: () => Effect.succeed(false) }),
    );

describe("EnterpriseTenancy", () => {
  it.effect("serves only the default tenant without configuration", () =>
    Effect.gen(function* () {
      const fallback = yield* Tenancy.EnterpriseTenancy;
      assert.isTrue(yield* allowed(fallback, "local"));
      assert.isFalse(yield* allowed(fallback, "acme"));
      yield* withTenants(undefined, (tenancy) =>
        Effect.gen(function* () {
          assert.isTrue(yield* allowed(tenancy, "local"));
          assert.isFalse(yield* allowed(tenancy, "acme"));
        }),
      );
    }),
  );

  it.effect("serves exactly the listed tenants and picks up revocation without restart", () =>
    withTenants(JSON.stringify({ version: 1, tenants: ["acme", "globex"] }), (tenancy, write) =>
      Effect.gen(function* () {
        assert.isTrue(yield* allowed(tenancy, "acme"));
        assert.isTrue(yield* allowed(tenancy, "globex"));
        // Listing tenants replaces the default rather than adding to it.
        assert.isFalse(yield* allowed(tenancy, "local"));
        yield* write(JSON.stringify({ version: 1, tenants: ["globex"] }));
        assert.isFalse(yield* allowed(tenancy, "acme"));
      }),
    ),
  );

  it.effect.each([
    ["malformed JSON", "{not json"],
    ["unknown version", JSON.stringify({ version: 2, tenants: ["local"] })],
    ["oversized file", JSON.stringify({ version: 1, tenants: ["local"], pad: "x".repeat(70_000) })],
  ])("denies every tenant for a %s", ([, contents]) =>
    withTenants(contents, (tenancy) =>
      Effect.gen(function* () {
        assert.isFalse(yield* allowed(tenancy, "local"));
      }),
    ),
  );

  it.effect("runs no RPC work when the payload tenant is rejected", () =>
    Effect.gen(function* () {
      const guard = Tenancy.withEnterpriseTenant(yield* Tenancy.EnterpriseTenancy);
      let ran = 0;
      const work = Effect.sync(() => ran++);
      const rejected = yield* guard(
        { workflow: { task: spec("acme") } },
        () => "rejected",
        work,
      ).pipe(Effect.flip);
      assert.equal(rejected, "rejected");
      assert.equal(ran, 0);
      yield* guard({ task: spec("local") }, () => "rejected", work);
      assert.equal(ran, 1);
    }),
  );
});
