import { ProviderInstanceId } from "@t3tools/contracts";
import {
  makeTraceSink,
  type TraceSink,
  type EffectTraceRecord,
} from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const lifecycleSpans = new Set([
  "ProviderAuthService.start",
  "ProviderAuthService.cancel",
  "ProviderAuthService.logout",
  "ProviderAuthService.importProfile",
  "ProviderAuthService.stopSessions",
  "providerAuthFlow.authenticate",
  "providerAuthFlow.persistCredentials",
]);

const isInstanceId = Schema.is(ProviderInstanceId);

function lifecycleRecord(record: EffectTraceRecord): EffectTraceRecord {
  const { instanceId, releasedSessions, purpose } = record.attributes;
  return {
    type: "effect-span",
    name: record.name,
    kind: "internal",
    traceId: record.traceId,
    spanId: record.spanId,
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    sampled: record.sampled,
    startTimeUnixNano: record.startTimeUnixNano,
    endTimeUnixNano: record.endTimeUnixNano,
    durationMs: record.durationMs,
    attributes: {
      ...(isInstanceId(instanceId) ? { instanceId } : {}),
      ...(typeof releasedSessions === "number" &&
      Number.isSafeInteger(releasedSessions) &&
      releasedSessions >= 0
        ? { releasedSessions }
        : {}),
      ...(purpose === "limits" ? { purpose } : {}),
    },
    exit:
      record.exit._tag === "Success"
        ? { _tag: "Success" }
        : { _tag: record.exit._tag, cause: record.exit._tag },
    events: [],
    links: [],
  };
}

/** Attach only to the server tracer. Browser trace uploads use the general sink directly. */
export const withProviderAuthTrace = Effect.fn("withProviderAuthTrace")(function* (
  general: TraceSink,
  logsDir: string,
  batchWindowMs: number,
) {
  const path = yield* Path.Path;
  const retained = yield* makeTraceSink({
    filePath: path.join(logsDir, "provider-auth.trace.ndjson"),
    maxBytes: 1024 * 1024,
    maxFiles: 2,
    batchWindowMs,
  });
  return {
    filePath: general.filePath,
    push(record) {
      general.push(record);
      if (record.type === "effect-span" && lifecycleSpans.has(record.name)) {
        retained.push(lifecycleRecord(record));
      }
    },
    flush: Effect.andThen(general.flush, retained.flush),
    flushSync() {
      general.flushSync();
      retained.flushSync();
    },
    close: () => Effect.andThen(general.close(), retained.close()),
  } satisfies TraceSink;
});
