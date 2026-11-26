import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

const layerHost = TestProviderHost.layer().pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layerAccounts = (read: CursorAccountReader.CursorAccountReader["Service"]["read"]) =>
  CursorUsageAccounts.layer.pipe(
    Layer.provide(Layer.succeed(CursorAccountReader.CursorAccountReader, { read })),
  );

const record = (accountKey: string, timestampMs: number): UsageRecord => ({
  provider: "cursor",
  timestampMs,
  model: "claude-fable-5",
  rateModel: "claude-fable-5",
  sessionId: accountKey,
  totals: {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: `cursor-account:${accountKey}:${timestampMs}`,
});

it.effect("restarts a split usage refresh when its account changes during backfill", () =>
  Effect.gen(function* () {
    let calls = 0;
    const read: CursorAccountReader.CursorAccountReader["Service"]["read"] = (_, from, to) =>
      Effect.sync(() => {
        calls++;
        if (calls === 1) {
          return { accountKey: "original", records: [], missing: false, error: "Too wide" };
        }
        const accountKey = calls === 2 ? "original" : "replacement";
        return {
          accountKey,
          records: [record(accountKey, Math.floor((from + to) / 2))],
          missing: false,
          error: null,
        };
      });
    yield* Effect.gen(function* () {
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
      yield* TestClock.setTime(8 * 60 * 60_000);
      const input = {
        instances: [
          {
            instanceId: ProviderInstanceId.make("work"),
            environment: { CURSOR_API_KEY: "test-key" },
          },
        ],
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      };
      yield* accounts.scan(input);
      yield* TestClock.adjust("1 minute");
      const history = yield* accounts.scan(input);
      assert.deepStrictEqual(
        history.map((source) => source.dir),
        ["cursor-account:replacement"],
      );
      const sessions = history.flatMap((source) =>
        (source.files ?? []).flatMap((file) => file.records.map((value) => value.sessionId)),
      );
      assert.isNotEmpty(sessions);
      assert.isTrue(sessions.every((session) => session === "replacement"));
    }).pipe(Effect.provide(layerAccounts(read)));
  }).pipe(Effect.provide(layerHost)),
);

it.effect("reads only each instance's configured or managed Cursor credentials", () =>
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    const write = (instanceId: string, json: string) =>
      host
        .credentials("cursor", instanceId)
        .pipe(Effect.flatMap((credentials) => credentials.set(new TextEncoder().encode(json))));
    yield* write(
      "managed",
      JSON.stringify({
        version: 1,
        backendUrl: "https://api.cursor.com",
        apiKey: "managed-test-key",
        createdAtMs: 0,
      }),
    );
    yield* write("damaged", "invalid json");
    yield* write("configured", "must not be read");
    const read: CursorAccountReader.CursorAccountReader["Service"]["read"] = (credential) =>
      Effect.succeed({
        accountKey: credential.apiKey.replace("-test-key", ""),
        records: [],
        missing: false,
        error: null,
      });
    yield* Effect.gen(function* () {
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
      yield* TestClock.setTime(8 * 60_000);
      const history = yield* accounts.scan({
        instances: [
          { instanceId: ProviderInstanceId.make("managed"), environment: {} },
          { instanceId: ProviderInstanceId.make("damaged"), environment: {} },
          { instanceId: ProviderInstanceId.make("signed-out"), environment: {} },
          {
            instanceId: ProviderInstanceId.make("configured"),
            environment: { CURSOR_API_KEY: " configured-test-key " },
          },
        ],
        windowStartMs: 0,
        retentionCutoffMs: 0,
        awaitRefresh: true,
      });
      assert.deepStrictEqual(
        history.map(({ dir, message }) => [dir, message]),
        [
          ["cursor-account:managed", undefined],
          ["cursor-account:configured", undefined],
          ["cursor-account-credentials", "Cursor credentials could not be read."],
        ],
      );
    }).pipe(Effect.provide(layerAccounts(read)));
  }).pipe(Effect.provide(layerHost)),
);
