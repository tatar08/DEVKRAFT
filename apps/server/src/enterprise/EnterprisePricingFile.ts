import * as Schema from "effect/Schema";

const Rate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/** On-disk price table: cents per one million tokens, keyed by model slug. Local models may be zero. */
export const PricingFile = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      inputCentsPerMillion: Rate,
      outputCentsPerMillion: Rate,
      cachedInputCentsPerMillion: Schema.optionalKey(Rate),
    }),
  ),
});
export const decodePricingFile = Schema.decodeUnknownEffect(Schema.fromJsonString(PricingFile));
