import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  billProject,
  emptyTaskCost,
  recordUsage,
  type PriceTable,
  type ProjectBilling,
} from "./EnterpriseCost.ts";
import { decodePricingFile } from "./EnterprisePricingFile.ts";

const MAX_FILE_BYTES = 1_048_576;
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Offline usage export: provider-reported token usage grouped by task. */
const UsageFile = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      records: Schema.Array(
        Schema.Struct({
          model: Schema.String,
          usage: Schema.Struct({
            inputTokens: Count,
            outputTokens: Count,
            cachedInputTokens: Schema.optionalKey(Count),
          }),
        }),
      ).check(Schema.isMaxLength(10_000)),
    }),
  ).check(Schema.isMaxLength(1_000)),
});
const decodeUsageFile = Schema.decodeUnknownEffect(Schema.fromJsonString(UsageFile));

export class EnterpriseCostReportError extends Schema.TaggedError<EnterpriseCostReportError>()(
  "EnterpriseCostReportError",
  { reason: Schema.Literals(["read", "too_large", "decode", "invalid_markup"]) },
) {
  // Never echo file contents: they may contain customer data.
  override get message(): string {
    return `Enterprise cost report failed: ${this.reason}.`;
  }
}

export interface CostReport extends ProjectBilling {
  readonly taskCount: number;
  readonly markupBps: number;
}

const readBounded = (fs: FileSystem.FileSystem, filePath: string) =>
  Effect.gen(function* () {
    const info = yield* fs
      .stat(filePath)
      .pipe(Effect.mapError(() => new EnterpriseCostReportError({ reason: "read" })));
    if (info.size > MAX_FILE_BYTES)
      return yield* new EnterpriseCostReportError({ reason: "too_large" });
    return yield* fs
      .readFileString(filePath)
      .pipe(Effect.mapError(() => new EnterpriseCostReportError({ reason: "read" })));
  });

/**
 * Bills a project's tasks from an offline usage export and an operator price table. Unpriced
 * usage is reported, never counted as free.
 */
export const buildCostReport = Effect.fn("EnterpriseCostReport.build")(function* (input: {
  readonly usagePath: string;
  readonly pricingPath: string;
  readonly projectId: string;
  readonly markupBps: number;
}) {
  if (!Number.isSafeInteger(input.markupBps) || input.markupBps < 0)
    return yield* new EnterpriseCostReportError({ reason: "invalid_markup" });
  const fs = yield* FileSystem.FileSystem;
  const decodeFailure = () => new EnterpriseCostReportError({ reason: "decode" });
  const pricing = yield* decodePricingFile(yield* readBounded(fs, input.pricingPath)).pipe(
    Effect.mapError(decodeFailure),
  );
  const usage = yield* decodeUsageFile(yield* readBounded(fs, input.usagePath)).pipe(
    Effect.mapError(decodeFailure),
  );
  const prices = pricing.models as PriceTable;
  const tasks = usage.tasks.map((task) =>
    task.records.reduce((state, record) => recordUsage(state, record, prices), emptyTaskCost),
  );
  const billing = billProject({ projectId: input.projectId, markupBps: input.markupBps, tasks });
  if (billing === null) return yield* new EnterpriseCostReportError({ reason: "invalid_markup" });
  return { ...billing, taskCount: tasks.length, markupBps: input.markupBps } satisfies CostReport;
});
