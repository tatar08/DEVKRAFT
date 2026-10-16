import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { TaskSpec } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";

/**
 * Tenant used when the operator has not configured any. A fresh environment can only run its own
 * local tasks; every other `TaskSpec.tenantId` is denied until the operator lists it.
 */
export const DEFAULT_ENTERPRISE_TENANT = "local";
export const TENANTS_FILE_NAME = "enterprise-tenants.json";
const MAX_TENANTS_BYTES = 65_536;

/** Operator-owned allowlist of tenants this environment may serve. */
export const TenantsFile = Schema.Struct({
  version: Schema.Literal(1),
  tenants: Schema.Array(TaskSpec.fields.tenantId).check(Schema.isMaxLength(256)),
});
const decodeTenantsFile = Schema.decodeUnknownEffect(Schema.fromJsonString(TenantsFile));

/** The task's tenant is not served by this environment. Callers must not touch task state. */
export class EnterpriseTenantRejected extends Data.TaggedError("EnterpriseTenantRejected")<{
  readonly tenantId: string;
}> {}

/**
 * Environment-level tenant boundary. Every Enterprise RPC, the background worker and every
 * workspace operation check the task's tenant here, so no path can create, read or advance task
 * state for an unlisted tenant.
 *
 * This is deny-by-default isolation between tenants on one host. It does not distinguish users
 * who share an environment: binding a tenant to an authenticated session needs a pairing-level
 * claim and is a separate change.
 */
export interface EnterpriseTenancyShape {
  readonly authorize: (tenantId: string) => Effect.Effect<void, EnterpriseTenantRejected>;
}

export class EnterpriseTenancy extends Context.Reference<EnterpriseTenancyShape>(
  "t3/enterprise/EnterpriseTenancy",
  {
    defaultValue: () => ({
      authorize: (tenantId) =>
        tenantId === DEFAULT_ENTERPRISE_TENANT
          ? Effect.void
          : Effect.fail(new EnterpriseTenantRejected({ tenantId })),
    }),
  },
) {}

/**
 * Reads `<stateDir>/enterprise-tenants.json` on every check so operators can grant or revoke a
 * tenant without restarting; a running workflow loses access on its next step.
 * Missing file: only the default tenant. Unreadable, oversized or invalid file: no tenant at all.
 */
export const layer = Layer.effect(
  EnterpriseTenancy,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const file = path.join(config.stateDir, TENANTS_FILE_NAME);
    const allowed = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return [DEFAULT_ENTERPRISE_TENANT] as ReadonlyArray<string>;
      const info = yield* fs.stat(file);
      if (info.size > MAX_TENANTS_BYTES) return [];
      return (yield* decodeTenantsFile(yield* fs.readFileString(file))).tenants;
    }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
    return {
      authorize: (tenantId: string) =>
        allowed.pipe(
          Effect.flatMap((tenants) =>
            tenants.includes(tenantId)
              ? Effect.void
              : Effect.fail(new EnterpriseTenantRejected({ tenantId })),
          ),
        ),
    };
  }),
);

/** Every Enterprise RPC payload carries its TaskSpec at one of these two places. */
export type EnterpriseTenantScopedInput =
  | { readonly task: TaskSpec }
  | { readonly workflow: { readonly task: TaskSpec } };

export const enterpriseInputTenant = (input: EnterpriseTenantScopedInput) =>
  "task" in input ? input.task.tenantId : input.workflow.task.tenantId;

/**
 * Runs `effect` only after the payload's tenant is authorized, so a rejected RPC performs no
 * work at all (not even a GitHub issue fetch). `reject` builds the RPC's own typed error.
 */
export const withEnterpriseTenant =
  (tenancy: EnterpriseTenancyShape) =>
  <A, E, R, E2>(
    input: EnterpriseTenantScopedInput,
    reject: () => E2,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | E2, R> =>
    tenancy
      .authorize(enterpriseInputTenant(input))
      .pipe(Effect.mapError(reject), Effect.andThen(effect));
