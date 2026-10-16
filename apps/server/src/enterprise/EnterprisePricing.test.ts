import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Pricing from "./EnterprisePricing.ts";

const withPricing = <A>(
  contents: string | undefined,
  use: (load: Effect.Effect<unknown>) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pricing-test-" });
    if (contents !== undefined)
      yield* fs.writeFileString(path.join(stateDir, Pricing.PRICING_FILE_NAME), contents);
    const layer = Pricing.layer.pipe(
      Layer.provide(Layer.succeed(ServerConfig, { stateDir } as ServerConfig["Service"])),
    );
    const service = yield* Pricing.EnterprisePricing.pipe(Effect.provide(layer));
    return yield* use(service.load);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("EnterprisePricing", () => {
  it.effect("is unconfigured by default and when the file is absent", () =>
    Effect.gen(function* () {
      const fallback = yield* Pricing.EnterprisePricing;
      assert.isUndefined(yield* fallback.load);
      assert.isUndefined(yield* withPricing(undefined, (load) => load));
    }),
  );

  it.effect("loads a valid table", () =>
    Effect.gen(function* () {
      const table = yield* withPricing(
        JSON.stringify({
          version: 1,
          models: {
            "gpt-6-luna": { inputCentsPerMillion: 100, outputCentsPerMillion: 400 },
            llama3: { inputCentsPerMillion: 0, outputCentsPerMillion: 0 },
          },
        }),
        (load) => load,
      );
      assert.deepEqual(Object.keys(table as object).toSorted(), ["gpt-6-luna", "llama3"]);
    }),
  );

  it.effect("fails closed to an empty table when the file is invalid", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* withPricing("{not json", (load) => load), {});
      assert.deepEqual(
        yield* withPricing(
          JSON.stringify({
            version: 1,
            models: { x: { inputCentsPerMillion: -1, outputCentsPerMillion: 0 } },
          }),
          (load) => load,
        ),
        {},
      );
    }),
  );
});
