import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import type { PriceTable } from "./EnterpriseCost.ts";
import { decodePricingFile } from "./EnterprisePricingFile.ts";

const MAX_PRICING_BYTES = 65_536;
/**
 * Operator-owned price table. `undefined` means pricing is not configured, so budgets are not
 * enforced and cost stays unknown. A table that exists but cannot be read or decoded is an empty
 * one: every model is then unpriced and the breaker fails closed.
 */
export class EnterprisePricing extends Context.Reference<{
  readonly load: Effect.Effect<PriceTable | undefined>;
}>("t3/enterprise/EnterprisePricing", {
  defaultValue: () => ({ load: Effect.succeed(undefined) }),
}) {}

export const PRICING_FILE_NAME = "enterprise-pricing.json";

export const layer = Layer.effect(
  EnterprisePricing,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const file = path.join(config.stateDir, PRICING_FILE_NAME);
    // Read on every use so operators can edit prices without restarting the server.
    const load = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return undefined;
      const info = yield* fs.stat(file);
      if (info.size > MAX_PRICING_BYTES) return {} as PriceTable;
      const decoded = yield* decodePricingFile(yield* fs.readFileString(file));
      return decoded.models as PriceTable;
    }).pipe(Effect.catch(() => Effect.succeed({} as PriceTable)));
    return { load };
  }),
);
