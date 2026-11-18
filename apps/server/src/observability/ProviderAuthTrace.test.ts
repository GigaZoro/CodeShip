import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeTraceSink, type EffectTraceRecord } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { withProviderAuthTrace } from "./ProviderAuthTrace.ts";

const privateText = "private incident fixture";
const record = (name: string, time: number): EffectTraceRecord => ({
  name,
  type: "effect-span",
  kind: "internal",
  traceId: "00112233445566778899aabbccddeeff",
  spanId: time.toString(16).padStart(16, "0"),
  sampled: true,
  startTimeUnixNano: String(time),
  endTimeUnixNano: String(time + 1),
  durationMs: 0.000001,
  attributes: { instanceId: "claudeAgent_2", unrelated: privateText },
  events: [{ name: privateText, timeUnixNano: String(time), attributes: {} }],
  links: [],
  exit: { _tag: "Success" },
});

const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
      exit: Schema.Struct({ _tag: Schema.String }),
      startTimeUnixNano: Schema.String,
    }),
  ),
);

describe("provider sign-in incident history", () => {
  it.effect(
    "survives full general trace rotation and reopening without retaining private payloads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "codeship-auth-trace-" });
          const trace = path.join(directory, "server.trace.ndjson");
          const open = Effect.gen(function* () {
            const general = yield* makeTraceSink({
              filePath: trace,
              maxBytes: 1024,
              maxFiles: 10,
              batchWindowMs: 1000,
            });
            return yield* withProviderAuthTrace(general, directory, 1000);
          });

          yield* Effect.scoped(
            Effect.gen(function* () {
              const sink = yield* open;
              sink.push(record("ProviderAuthService.start", 1));
              sink.push({
                ...record("providerAuthFlow.authenticate", 2),
                exit: { _tag: "Interrupted", cause: privateText },
              });
              sink.push(record("ProviderAuthService.cancel", 3));
              yield* sink.flush;
              for (let i = 0; i < 35; i++) {
                sink.push(record("sqlite", 10 + i));
              }
            }),
          );
          assert.isTrue(yield* fs.exists(trace + ".10"));
          for (let i = 0; i <= 10; i++) {
            const ordinary = yield* fs.readFileString(i === 0 ? trace : trace + "." + i);
            assert.notInclude(ordinary, "ProviderAuthService.start");
          }
          yield* Effect.scoped(
            Effect.gen(function* () {
              const reopened = yield* open;
              reopened.push(record("providerAuthFlow.persistCredentials", 51));
              reopened.push({
                ...record("ProviderAuthService.stopSessions", 52),
                attributes: {
                  instanceId: "claudeAgent_2",
                  releasedSessions: 12,
                  details: privateText,
                },
              });
            }),
          );

          const history = yield* fs.readFileString(
            path.join(directory, "provider-auth.trace.ndjson"),
          );
          assert.notInclude(history, privateText);
          assert.notInclude(history, "sqlite");
          const entries = history
            .trim()
            .split("\n")
            .map((line) => decodeRecord(line));
          assert.deepEqual(
            entries.map((entry) => entry.name),
            [
              "ProviderAuthService.start",
              "providerAuthFlow.authenticate",
              "ProviderAuthService.cancel",
              "providerAuthFlow.persistCredentials",
              "ProviderAuthService.stopSessions",
            ],
          );
          assert.deepEqual(
            entries.map((entry) => entry.startTimeUnixNano),
            ["1", "2", "3", "51", "52"],
          );
          assert.strictEqual(entries[1]?.exit._tag, "Interrupted");
          assert.deepEqual(entries.at(-1)?.attributes, {
            instanceId: "claudeAgent_2",
            releasedSessions: 12,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
