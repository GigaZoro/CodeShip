// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import { totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as UsageService from "./UsageService.ts";
import * as MuseSdk from "../../../../packages/provider-muse/src/server/sdk.ts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import {
  isLegacyScanCacheFileName,
  isScanCacheInput,
  SCAN_CACHE_DIRECTORY_NAME,
  SCAN_CACHE_PIECE_CHARS,
  scanCacheDocumentPieces,
  USAGE_SCAN_CACHE_VERSION,
  type ScanCache,
} from "./usageScanCache.ts";
import { PathCallPendingError, STAT_CONCURRENCY } from "./usageTranscriptReader.ts";

vi.mock("node:fs/promises", { spy: true });
vi.mock("../../../../packages/provider-muse/src/server/sdk.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof MuseSdk>()),
  createMuseSdkHostEffect: vi.fn(() =>
    Effect.try(() => {
      throw new Error("Muse is not installed in this test");
    }),
  ),
}));

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonString = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

function claudeLine(
  id: number,
  outputTokens: number,
  model = "claude-fable-5",
  sessionId = "session-1",
): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId,
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

/** Writes one Claude line last modified at CURSOR_NOW. */
const writeTranscriptAtCursorNow = (transcript: string, outputTokens: number) =>
  Effect.promise(async () => {
    await NodeFSP.writeFile(transcript, claudeLine(1, outputTokens));
    await NodeFSP.utimes(transcript, CURSOR_NOW / 1000, CURSOR_NOW / 1000);
  });

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  // The service reports real paths; macOS tmpdir sits behind the /var -> /private/var link.
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")).then((home) =>
      NodeFSP.realpath(home),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: NodePath.join(home, "claude") },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: NodePath.join(home, "codex") },
        },
      },
    },
  };
});

const layerCursorUsageAccounts = <E, R>(
  reader: Layer.Layer<CursorAccountReader.CursorAccountReader, E, R>,
) => Layer.fresh(CursorUsageAccounts.layer).pipe(Layer.provide(reader));

const makeWithCursor = (read: CursorAccountReader.CursorAccountReader["Service"]["read"]) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      layerCursorUsageAccounts(Layer.succeed(CursorAccountReader.CursorAccountReader, { read })),
    );
    const accounts = Context.get(context, CursorUsageAccounts.CursorUsageAccounts);
    const service = yield* UsageService.make.pipe(Effect.provideContext(context));
    return {
      ...service,
      awaitPersisted: Effect.andThen(service.awaitPersisted, accounts.awaitPersisted),
    };
  });

const serverKey = (byte: number) =>
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(byte)),
  });

const layerService = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly onRatesFetch?: (request: HttpClientRequest.HttpClientRequest) => void;
  readonly ratesDocument?: unknown;
  readonly ratesStatus?: () => number;
  readonly ratesResponse?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly hostname?: string;
}) =>
  layerCursorUsageAccounts(
    CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer)),
  ).pipe(
    Layer.provideMerge(AntigravityUsage.layer),
    Layer.provideMerge(MuseUsageHome.layer),
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provideMerge(serverKey(1)),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), NodePath.join(input.home, input.prefix)),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, input.platform ?? "linux")),
    Layer.provideMerge(Layer.succeed(HostProcess.Hostname, input.hostname ?? "usage-test-host")),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.suspend(() => {
            input.onRatesFetch?.(request);
            const response = input.ratesResponse
              ? input.ratesResponse(request)
              : Effect.succeed(
                  Response.json(input.ratesDocument ?? {}, {
                    status: input.ratesStatus?.() ?? 200,
                  }),
                );
            return response.pipe(
              Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
            );
          }),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, {
        HOME: input.home,
        GROK_HOME: NodePath.join(input.home, "grok"),
        PI_CODING_AGENT_DIR: NodePath.join(input.home, "pi"),
        OPENCODE_DATA_DIR: NodePath.join(input.home, "opencode"),
        ANTIGRAVITY_DATA_DIR: NodePath.join(input.home, "antigravity"),
        XDG_CONFIG_HOME: NodePath.join(input.home, "config"),
        APPDATA: NodePath.join(input.home, "config"),
        ...input.environment,
      }),
    ),
  );

const NARROW_WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-02"),
};

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

const CURSOR_NOW = Date.parse("2026-08-02T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeFakeCursor() {
  const state = {
    accountKey: "account-a",
    events: [] as { readonly timestampMs: number; readonly outputTokens: number }[],
    error: null as string | null,
    gate: undefined as Deferred.Deferred<void> | undefined,
    calls: [] as { readonly sinceMs: number; readonly untilMs: number }[],
  };
  const read = (_credential: unknown, sinceMs: number, untilMs: number) =>
    Effect.gen(function* () {
      state.calls.push({ sinceMs, untilMs });
      if (state.gate !== undefined) yield* Deferred.await(state.gate);
      const { accountKey, error } = state;
      if (error !== null) return { accountKey, records: [], missing: false, error };
      const occurrences = new Map<string, number>();
      const records = state.events
        .filter(({ timestampMs }) => timestampMs >= sinceMs && timestampMs <= untilMs)
        .map(({ timestampMs, outputTokens }): UsageRecord => {
          const key = `${timestampMs}:${outputTokens}`;
          const occurrence = occurrences.get(key) ?? 0;
          occurrences.set(key, occurrence + 1);
          return {
            provider: "cursor",
            timestampMs,
            model: "claude-fable-5",
            sessionId: "conversation-1",
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens,
              reasoningTokens: 0,
            },
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
          };
        });
      return { accountKey, records, missing: false, error: null };
    });
  return { state, read };
}

const writeCursorLogin = (home: string) =>
  Effect.promise(async () => {
    const authPath = NodePath.join(home, "config", "cursor", "auth.json");
    await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
    await NodeFSP.writeFile(authPath, "{}");
  });

function cursorSource(summary: { readonly sources: readonly UsageSource[] }) {
  return summary.sources.find((source) => source.fingerprint.provider === "cursor");
}

function claudeSource(summary: { readonly sources: readonly UsageSource[] }) {
  return summary.sources.find((source) => source.fingerprint.provider === "claude");
}

const storeDirOf = (stateDir: string) => NodePath.join(stateDir, SCAN_CACHE_DIRECTORY_NAME);

/** The rename that publishes a finished snapshot; a legacy claim renames from the state directory. */
const isSnapshotPublish = (stateDir: string, from: string, to: string) =>
  NodePath.dirname(to) === storeDirOf(stateDir) && NodePath.dirname(from) !== stateDir;

interface StoredRow {
  s: number;
  m: number;
  oa?: number;
  ms?: number;
  nr?: true;
  mr: number;
  r: unknown[][];
  cs: Record<string, unknown>;
}

interface StoredDocument {
  version: number;
  files: Record<string, StoredRow>;
  sources: Record<string, unknown>;
  sessions: string[];
  models: string[];
}

/** The saved snapshots, by name; a test that ran one service has one. */
const readStore = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = storeDirOf(stateDir);
    const names = yield* fs.readDirectory(dir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed<readonly string[]>([]),
      ),
    );
    return yield* Effect.forEach(names.filter(isScanCacheInput).sort(), (name) =>
      fs
        .readFileString(NodePath.join(dir, name))
        .pipe(Effect.map((raw) => ({ name, path: NodePath.join(dir, name), raw }))),
    );
  });

const onlySnapshot = (stateDir: string) =>
  Effect.gen(function* () {
    const stored = yield* readStore(stateDir);
    assert.lengthOf(stored, 1);
    const { path, raw } = stored[0]!;
    return { path, raw, document: decodeUnknownJsonString(raw) as StoredDocument };
  });

/** The snapshot with the highest sequence number: the last save of a test's only writer. */
const newestSnapshot = (stateDir: string) =>
  Effect.map(readStore(stateDir), (stored) => {
    assert.isNotEmpty(stored);
    const seq = (name: string) => Number(/-(\d+)\.json$/.exec(name)?.[1]);
    const newest = stored.reduce((best, next) => (seq(next.name) > seq(best.name) ? next : best));
    return { ...newest, document: decodeUnknownJsonString(newest.raw) as StoredDocument };
  });

const storedFileKeys = (stateDir: string) =>
  Effect.map(readStore(stateDir), (stored) => [
    ...new Set(
      stored.flatMap(({ raw }) =>
        Object.keys((decodeUnknownJsonString(raw) as StoredDocument).files),
      ),
    ),
  ]);

/** Reads with a fresh service, which loads saved usage and saves it again as it shuts down. */
const outputTokensAfterRestart = Effect.scoped(
  Effect.gen(function* () {
    const service = yield* UsageService.make;
    const tokens = totalOutputTokens(yield* service.readSummary(WINDOW));
    yield* service.awaitPersisted;
    return tokens;
  }),
);

const encodeSnapshot = (rows: ScanCache, extra: Readonly<Record<string, unknown>> = {}) =>
  [...scanCacheDocumentPieces(rows, extra)].join("");

let seededSnapshots = 0;
/** Writes a snapshot as another process would, under a writer id no service uses. */
const seedSnapshot = (stateDir: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = storeDirOf(stateDir);
    yield* fs.makeDirectory(dir, { recursive: true });
    seededSnapshots += 1;
    const file = NodePath.join(dir, `00000000-0000-4000-8000-000000000000-${seededSnapshots}.json`);
    yield* fs.writeFileString(file, contents);
    return file;
  });

/** Collects log lines; `of` returns the fields logged with one message at one level. */
const captureLogs = () => {
  const lines: { readonly level: string; readonly message: unknown }[] = [];
  const logger = Logger.make(({ message, logLevel }) => {
    lines.push({ level: logLevel, message });
  });
  return {
    layer: Logger.layer([logger], { mergeWithExisting: false }),
    of: (level: "Error" | "Warn" | "Info", text: string) =>
      lines.flatMap(({ level: logged, message }) =>
        logged === level && Array.isArray(message) && message[0] === text ? [message[1]] : [],
      ),
  };
};

const PERMISSION_DENIED = (method: string) =>
  PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method });

/** How a rename fails on Windows while another program holds the file open. */
const RENAME_LOCKED = (path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "rename",
    pathOrDescriptor: path,
    cause: Object.assign(new Error("EPERM, rename"), { code: "EPERM" }),
  });

const seedCodexHistory = (input: {
  id: string;
  nativeTurnId?: string;
  sessionId?: string;
  model?: string;
  options?: readonly { id: string; value: string | boolean }[];
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { id } = input;
    const selection = {
      instanceId: "codex",
      model: input.model ?? "gpt-6-astra",
      options: input.options ?? [{ id: "serviceTier", value: "priority" }],
    };
    const run = {
      id: `run-${id}`,
      activeAttemptId: `attempt-${id}`,
      status: "running",
      modelSelection: selection,
    };
    yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
      attempt_id: run.activeAttemptId,
      thread_id: `thread-${id}`,
      run_id: run.id,
      attempt_ordinal: 1,
      root_node_id: `node-${id}`,
      provider: "codex",
      provider_thread_id: `provider-thread-${id}`,
      provider_turn_id: `turn-${id}`,
      status: "completed",
      payload_json: encodeUnknownJsonString({ nativeThreadId: input.sessionId ?? "session" }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
      provider_turn_id: `turn-${id}`,
      thread_id: `thread-${id}`,
      provider_thread_id: `provider-thread-${id}`,
      node_id: `node-${id}`,
      run_attempt_id: run.activeAttemptId,
      ordinal: 1,
      status: "completed",
      payload_json: encodeUnknownJsonString({
        nativeTurnRef: { driver: "codex", nativeId: input.nativeTurnId ?? id, strength: "strong" },
      }),
    })}`;
    const changedSelection = {
      ...selection,
      options: [{ id: "serviceTier", value: "ultrafast" }],
    };
    // These selections disagree so reading the current projection or the wrong event is visible.
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: run.id,
      thread_id: `thread-${id}`,
      ordinal: 1,
      provider: "codex",
      provider_thread_id: `provider-thread-${id}`,
      status: "completed",
      requested_at: "2026-08-01T10:00:00Z",
      payload_json: encodeUnknownJsonString({
        ...run,
        status: "completed",
        modelSelection: { ...selection, options: [] },
      }),
    })}`;
    for (const [index, payload] of [
      { ...run, activeAttemptId: "earlier-attempt", modelSelection: changedSelection },
      { ...run, status: "queued", modelSelection: changedSelection },
      run,
      { ...run, modelSelection: changedSelection },
    ].entries()) {
      yield* sql`INSERT INTO orchestration_events ${sql.insert({
        event_id: `event-${id}-${index}`,
        aggregate_kind: "thread",
        stream_id: `thread-${id}`,
        stream_version: index + 1,
        event_type: "run.updated",
        occurred_at: "2026-08-01T10:00:00Z",
        actor_kind: "system",
        metadata_json: "{}",
        application_event_version: 2,
        payload_json: encodeUnknownJsonString(payload),
      })}`;
    }
  });

describe("Codex usage history", () => {
  const historyLayer = CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
  const request = (nativeTurnId: string) => ({
    sessionId: "session",
    nativeTurnId,
    model: "gpt-6-astra",
  });

  it.effect("resolves a batch from each attempt's first running selection", () =>
    Effect.gen(function* () {
      yield* seedCodexHistory({ id: "fast" });
      yield* seedCodexHistory({
        id: "ultrafast",
        options: [{ id: "serviceTier", value: "ultrafast" }],
      });
      yield* seedCodexHistory({ id: "legacy-option", options: [{ id: "fastMode", value: true }] });
      yield* seedCodexHistory({ id: "standard", options: [] });
      const requests = ["fast", "ultrafast", "legacy-option", "standard", "fast"].map(request);
      const history = yield* CodexUsageHistory.CodexUsageHistory;
      const resolved = yield* history.resolve(requests);
      assert.strictEqual(resolved.size, requests.length);
      assert.deepStrictEqual(
        requests.map((item) => resolved.get(item)),
        ["fast", "ultrafast", "fast", "standard", "fast"],
      );
    }).pipe(Effect.provide(historyLayer)),
  );

  it.effect("leaves ambiguous, mismatched, and missing V2 evidence unresolved", () =>
    Effect.gen(function* () {
      for (const id of [
        "valid",
        "duplicate-model",
        "duplicate-session",
        "imported",
        "v1-event",
        "queued",
        "missing-selection",
      ]) {
        yield* seedCodexHistory({ id });
      }
      yield* seedCodexHistory({
        id: "second-model",
        nativeTurnId: "duplicate-model",
        model: "other-model",
      });
      yield* seedCodexHistory({
        id: "second-session",
        nativeTurnId: "duplicate-session",
        sessionId: "other-session",
      });
      yield* seedCodexHistory({ id: "wrong-model", model: "other-model" });
      yield* seedCodexHistory({ id: "wrong-session", sessionId: "other-session" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_provider_turns
        SET run_attempt_id = NULL WHERE provider_turn_id = 'turn-imported'`;
      yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id = 'attempt-imported'`;
      yield* sql`UPDATE orchestration_events SET application_event_version = 1
        WHERE stream_id = 'thread-v1-event'`;
      yield* sql`UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.status', 'queued')
        WHERE stream_id = 'thread-queued'`;
      yield* sql`UPDATE orchestration_events
        SET payload_json = json_remove(payload_json, '$.modelSelection')
        WHERE event_id = 'event-missing-selection-2'`;
      const requests = [
        "valid",
        "duplicate-model",
        "duplicate-session",
        "wrong-model",
        "wrong-session",
        "missing-turn",
        "imported",
        "v1-event",
        "queued",
        "missing-selection",
      ].map(request);
      const history = yield* CodexUsageHistory.CodexUsageHistory;
      const resolved = yield* history.resolve(requests);
      assert.deepStrictEqual([...resolved], [[requests[0], "fast"]]);
    }).pipe(Effect.provide(historyLayer)),
  );

  it.effect(
    "reports SQL failures through the typed channel and can resolve again after repair",
    () =>
      Effect.gen(function* () {
        yield* seedCodexHistory({ id: "retry" });
        const history = yield* CodexUsageHistory.CodexUsageHistory;
        const sql = yield* SqlClient.SqlClient;
        const input = request("retry");
        yield* sql`ALTER TABLE orchestration_events RENAME TO unavailable_events`;
        const error = yield* Effect.flip(history.resolve([input]));
        assert.instanceOf(error, CodexUsageHistory.CodexUsageHistoryReadError);
        assert.strictEqual(error.requestedTurnCount, 1);
        yield* sql`ALTER TABLE unavailable_events RENAME TO orchestration_events`;
        assert.strictEqual((yield* history.resolve([input])).get(input), "fast");
      }).pipe(Effect.provide(historyLayer)),
  );
});

describe("UsageService", () => {
  it.live("counts compressed Codex rollouts across refresh, rewrites, and cache restarts", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const sessions = NodePath.join(home, "codex", "sessions");
      const compressedPath = NodePath.join(sessions, "compressed.jsonl.zst");
      const usage = (output_tokens: number, timestamp = "2026-08-01T10:00:00Z") =>
        encodeUnknownJsonString({
          type: "event_msg",
          timestamp,
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 10, output_tokens } },
          },
        }) + "\n";
      const rollout = (id: string, output: number) =>
        [
          { type: "session_meta", payload: { id } },
          { type: "turn_context", payload: { model: "gpt-6-astra" } },
        ]
          .map((line) => encodeUnknownJsonString(line))
          .join("\n") +
        "\n" +
        usage(output);
      const compressed = rollout("compressed-session", 23);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sessions, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(sessions, "plain.jsonl"),
          rollout("plain-session", 17),
        );
        await NodeFSP.writeFile(compressedPath, NodeZlib.zstdCompressSync(compressed));
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 40);
        assert.strictEqual(
          first.sources.find((source) => source.fingerprint.provider === "codex")?.distinctSessions,
          2,
        );
        assert.deepStrictEqual((yield* service.readSummary(WINDOW)).buckets, first.buckets);
        yield* service.awaitPersisted;
        // The same rollout may remain in a plain file while compression finishes.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(sessions, "copy.jsonl"), compressed),
        );
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 40);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            compressedPath,
            NodeZlib.zstdCompressSync(compressed + usage(31, "2026-08-01T10:00:05Z")),
          ),
        );
        const rewritten = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(rewritten), 71);
        assert.deepStrictEqual((yield* service.readSummary(WINDOW)).buckets, rewritten.buckets);
        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, rewritten.buckets);
        yield* restarted.awaitPersisted;
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix: "usage-compressed-codex", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reads a seven-day hourly window and rejects longer requests", () =>
    Effect.gen(function* () {
      const { home, settings, transcript } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          claudeLine(1, 42) +
            claudeLine(2, 99).replace("2026-08-01T10:00:00Z", "2026-08-08T00:00:00Z"),
        ),
      );
      const context = yield* Layer.build(layerService({ prefix: "week", home, settings }));
      const service = yield* UsageService.make.pipe(Effect.provideContext(context));
      const input: UsageSummaryInput = {
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-08"),
        resolution: "hour",
        sinceTime: "2026-08-01T00:00:00Z",
        untilTime: "2026-08-08T00:00:00Z",
      };
      const summary = yield* service.readSummary(input);
      assert.strictEqual(totalOutputTokens(summary), 42);
      const merged = mergeUsage(
        [{ environmentId: EnvironmentId.make("test"), label: "Test", summary }],
        USAGE_CONTRACT_VERSION,
      );
      assert.strictEqual(merged.hourly[0]?.hourStart, "2026-08-01T10:00:00.000Z");
      const error = yield* Effect.flip(
        service.readSummary({ ...input, sinceTime: "2026-07-31T23:59:59Z" }),
      );
      assert.strictEqual(error.reason, "invalidWindow");
    }).pipe(Effect.scoped),
  );

  it.live("keeps the first host identity across recreation and explicit override removal", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      for (const [hostname, override, expected] of [
        ["container-a", undefined, "container-a"],
        ["container-b", undefined, "container-a"],
        ["container-c", "physical-host", "physical-host"],
        ["container-d", undefined, "container-a"],
      ] as const) {
        const summary = yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          return yield* service.readSummary(WINDOW);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-host-id",
              home,
              settings,
              hostname,
              environment: override === undefined ? {} : { T3CODE_HOST_ID: override },
            }),
          ),
        );
        const source = summary.sources.find((source) => source.fingerprint.provider === "claude");
        assert.strictEqual(source?.fingerprint.hostId, expected);
      }
    }).pipe(Effect.scoped),
  );

  it.live("concurrent initialization keeps one host identity across service recreation", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const prefix = "usage-host-id-race";
      const hostIdPath = NodePath.join(home, prefix, "usage-host-id");
      const bothRead = yield* Deferred.make<void>();
      let reads = 0;
      const summaries = yield* Effect.forEach(
        ["container-a", "container-b"],
        (hostname) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            let firstRead = true;
            const service = yield* UsageService.make.pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fileSystem,
                readFileString: (path, encoding) =>
                  Effect.gen(function* () {
                    if (path !== hostIdPath || !firstRead) {
                      return yield* fileSystem.readFileString(path, encoding);
                    }
                    firstRead = false;
                    // Both instances observe the missing file before either can create it.
                    const result = yield* Effect.exit(fileSystem.readFileString(path, encoding));
                    reads += 1;
                    if (reads === 2) yield* Deferred.succeed(bothRead, undefined);
                    yield* Deferred.await(bothRead);
                    return yield* result;
                  }),
              }),
            );
            return yield* service.readSummary(WINDOW);
          }).pipe(
            Effect.scoped,
            Effect.provide(layerService({ prefix, home, settings, hostname })),
          ),
        { concurrency: "unbounded" },
      );
      const persisted = yield* Effect.promise(() => NodeFSP.readFile(hostIdPath, "utf8"));
      const hostId = persisted.trim();
      assert.include(["container-a", "container-b"], hostId);
      const restarted = yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        return yield* service.readSummary(WINDOW);
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix, home, settings, hostname: "container-c" })),
      );
      for (const summary of [...summaries, restarted]) {
        const source = summary.sources.find((source) => source.fingerprint.provider === "claude");
        assert.strictEqual(source?.fingerprint.hostId, hostId);
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "repairs initial Codex prices after unchanged-file retries, persists evidence and corrections, and honors later native tiers",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const fastPath = NodePath.join(sessions, "fast.jsonl");
        const ultraPath = NodePath.join(sessions, "ultra.jsonl");
        const meta = (id: string) => ({
          type: "session_meta",
          payload: { id, model_provider: "openai" },
        });
        const context = (turn_id?: string) => ({
          type: "turn_context",
          payload: { model: "gpt-6-astra", turn_id },
        });
        const usage = (output_tokens: number) => ({
          type: "event_msg",
          timestamp: "2026-08-01T10:00:00Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 0, output_tokens } },
          },
        });
        const tier = (service_tier?: string) => ({
          type: "event_msg",
          payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
        });
        const lines = (records: readonly unknown[]) =>
          records.map((record) => encodeUnknownJsonString(record)).join("\n") + "\n";
        const verify = (summary: UsageSummary, output: number, cost: number) => {
          assert.strictEqual(totalOutputTokens(summary), output);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            cost,
          );
        };
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(
            fastPath,
            lines([meta("fast-session"), context("fast-turn"), usage(1)]) +
              encodeUnknownJsonString(usage(2)),
          );
          await NodeFSP.writeFile(
            ultraPath,
            lines([meta("ultra-session"), context("ultra-turn"), usage(4)]),
          );
        });
        yield* Effect.gen(function* () {
          const first = yield* UsageService.make;
          verify(yield* first.readSummary(WINDOW), 7, 7);
          yield* first.awaitPersisted;
          const pending = yield* UsageService.make;
          verify(yield* pending.readSummary(WINDOW), 7, 7);
          yield* seedCodexHistory({ id: "fast-turn", sessionId: "fast-session" });
          yield* seedCodexHistory({
            id: "ultra-turn",
            sessionId: "ultra-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          const sql = yield* SqlClient.SqlClient;
          yield* sql`ALTER TABLE orchestration_events RENAME TO unavailable_events`;
          verify(yield* pending.readSummary(WINDOW), 7, 7);
          yield* pending.awaitPersisted;
          const retry = yield* UsageService.make;
          verify(yield* retry.readSummary(WINDOW), 7, 7);
          yield* sql`ALTER TABLE unavailable_events RENAME TO orchestration_events`;
          // History repair must touch both the committed record and tentative tail.
          verify(yield* retry.readSummary(WINDOW), 7, 30);
          yield* retry.awaitPersisted;
          yield* sql`ALTER TABLE orchestration_events RENAME TO resolved_events`;
          verify(yield* retry.readSummary(WINDOW), 7, 30);
          const resolved = yield* UsageService.make;
          verify(yield* resolved.readSummary(WINDOW), 7, 30);
          yield* sql`ALTER TABLE resolved_events RENAME TO orchestration_events`;

          // Completing the tail reparses it; neither an absent turn ID nor a new
          // turn with no retained attempt may inherit the inferred Fast speed.
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              fastPath,
              "\n" + lines([context(), usage(3), context("unretained-turn"), usage(4)]),
            ),
          );
          verify(yield* resolved.readSummary(WINDOW), 14, 37);
          yield* seedCodexHistory({
            id: "native-turn",
            sessionId: "fast-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          yield* seedCodexHistory({ id: "later-native-turn", sessionId: "fast-session" });
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              fastPath,
              lines([
                context("native-turn"),
                tier(),
                usage(5),
                context("later-native-turn"),
                usage(6),
                tier("priority"),
              ]) + encodeUnknownJsonString(usage(7)),
            ),
          );
          verify(yield* resolved.readSummary(WINDOW), 32, 62);
          yield* resolved.awaitPersisted;
          const native = yield* UsageService.make;
          verify(yield* native.readSummary(WINDOW), 32, 62);
          yield* seedCodexHistory({
            id: "after-restart-native",
            sessionId: "fast-session",
            options: [{ id: "serviceTier", value: "ultrafast" }],
          });
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              fastPath,
              "\n" +
                lines([context("after-restart-native"), usage(8), tier("ultrafast"), usage(9)]),
            ),
          );
          verify(yield* native.readSummary(WINDOW), 49, 132);
          yield* native.awaitPersisted;
          yield* Effect.promise(async () => {
            await NodeFSP.rm(fastPath);
            await NodeFSP.rm(ultraPath);
          });
          yield* sql`DELETE FROM orchestration_events`;
          const deleted = yield* UsageService.make;
          verify(yield* deleted.readSummary(WINDOW), 49, 132);
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-initial-tier",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("keeps the read time when a tier resolves, so a peer's later read wins the merge", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const sessions = NodePath.join(home, "codex", "sessions");
      const transcript = NodePath.join(sessions, "tier.jsonl");
      const lines = (records: readonly unknown[]) =>
        records.map((record) => encodeUnknownJsonString(record)).join("\n") + "\n";
      const usage = (output_tokens: number) => ({
        type: "event_msg",
        timestamp: "2026-08-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 0, output_tokens } },
        },
      });
      // Older than a day, so a cached listing does not stat it again.
      const writeCold = (contents: string, mtimeMs: number) =>
        Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(transcript, contents);
          await NodeFSP.utimes(transcript, mtimeMs / 1000, mtimeMs / 1000);
          return (await NodeFSP.stat(transcript)).size;
        });
      const opening = lines([
        { type: "session_meta", payload: { id: "tier-session", model_provider: "openai" } },
        { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "tier-turn" } },
        usage(4),
      ]);
      yield* TestClock.setTime(CURSOR_NOW);
      yield* writeCold(opening, Date.parse("2026-08-01T10:00:00Z"));

      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const old = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* old.readSummary(WINDOW)), 4);
        yield* old.awaitPersisted;

        yield* TestClock.adjust("1 second");
        const peerSize = yield* writeCold(
          opening + lines([usage(5)]),
          Date.parse("2026-08-01T10:01:00Z"),
        );
        const peer = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* peer.readSummary(WINDOW)), 9);
        yield* peer.awaitPersisted;

        yield* seedCodexHistory({
          id: "tier-turn",
          sessionId: "tier-session",
          options: [{ id: "serviceTier", value: "ultrafast" }],
        });
        yield* TestClock.adjust("1 second");
        const corrected = yield* old.readSummary(WINDOW);
        assert.strictEqual(corrected.buckets[0]?.costUsd, 24);
        yield* old.awaitPersisted;

        const { document } = yield* onlySnapshot(stateDir);
        const row = document.files[transcript];
        assert.deepStrictEqual([row?.s, row?.oa], [peerSize, CURSOR_NOW + 1000]);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-tier-correction-merge",
            home,
            settings,
            ratesDocument: {
              "gpt-6-astra": {
                input_cost_per_token: 0,
                output_cost_per_token: 1,
                input_cost_per_token_ultrafast: 0,
                output_cost_per_token_ultrafast: 6,
              },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    "reads Pi per-model usage and auxiliary costs once across forks and repeated entries",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const dir = NodePath.join(home, "pi", "sessions", "project");
        const usage = {
          input: 10,
          output: 5,
          cacheRead: 20,
          cacheWrite: 3,
          reasoning: 2,
          totalTokens: 38,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
        };
        const parent = {
          type: "message",
          id: "a123abcd",
          parentId: null,
          timestamp: "2026-08-01T10:00:00Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "requested-model",
            responseModel: "actual-model",
            usage,
          },
        };
        const auxiliary = [
          {
            type: "message",
            id: "tool",
            message: { role: "toolResult", toolName: "classify", usage },
          },
          {
            type: "message",
            id: "image",
            message: {
              role: "toolResult",
              toolName: "image",
              usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
          { type: "compaction", id: "compact", usage },
          { type: "branch_summary", id: "summary", usage },
        ].map((entry) => ({ ...entry, timestamp: "2026-08-01T11:00:00Z" }));
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "parent.jsonl"),
            [
              { type: "session", id: "parent" },
              parent,
              ...auxiliary,
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T12:00:00Z",
                kind: "cache_warm",
                provider: "openai",
                model: "actual-model",
                usage: { ...usage, cost: { ...usage.cost, total: 0 } },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(dir, "fork.jsonl"),
            [
              { type: "session", id: "fork", parentSession: NodePath.join(dir, "parent.jsonl") },
              { ...parent, parentId: "relinked" },
              parent,
              ...auxiliary,
              {
                ...parent,
                timestamp: "2026-08-01T13:00:00Z",
                message: { ...parent.message, provider: "openai", responseModel: "another-model" },
              },
              { type: "get_session_stats", usage: { ...usage, cost: { total: 1000 } } },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          const pi = first.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(
            pi.reduce((total, bucket) => total + bucket.costUsd, 0),
            44,
          );
          assert.strictEqual(
            pi.reduce((total, bucket) => total + totalTokens(bucket.totals), 0),
            228,
          );
          assert.deepStrictEqual(pi.map((bucket) => bucket.model).sort(), [
            "Tools/summaries",
            "anthropic/actual-model",
            "openai/actual-model",
            "openai/another-model",
          ]);
          const assistant = pi.find((bucket) => bucket.model === "anthropic/actual-model");
          assert.deepStrictEqual(assistant?.totals, {
            uncachedInputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 20,
            cacheCreationTokens: 3,
            reasoningTokens: 2,
          });
          assert.strictEqual(assistant?.costSource, "providerReported");
          assert.approximately(assistant?.categoryCostUsd?.input ?? NaN, 10 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.cacheRead ?? NaN, 2 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.cacheWrite ?? NaN, 6 / 38, 1e-6);
          assert.approximately(assistant?.categoryCostUsd?.output ?? NaN, 20 / 38, 1e-6);
          assert.strictEqual(assistant?.cacheSavingsUsd, 18);
          const warm = pi.find((bucket) => bucket.model === "openai/actual-model");
          assert.strictEqual(warm?.costSource, "modelPriced");
          assert.strictEqual(warm?.costUsd, 38);
          assert.deepStrictEqual(warm?.categoryCostUsd, {
            input: 10,
            cacheRead: 2,
            cacheWrite: 6,
            output: 20,
          });
          assert.strictEqual(warm?.cacheSavingsUsd, 18);
          assert.strictEqual(
            first.sources.filter((source) => source.fingerprint.provider === "pi").length,
            1,
          );
          yield* Effect.promise(() =>
            NodeFSP.appendFile(
              NodePath.join(dir, "fork.jsonl"),
              encodeUnknownJsonString({
                ...parent,
                id: "new",
                timestamp: "2026-08-01T14:00:00Z",
                message: { ...parent.message, responseModel: "latest-model" },
              }) + "\n",
            ),
          );
          const grown = yield* service.readSummary(WINDOW);
          assert.strictEqual(
            grown.buckets
              .filter((bucket) => bucket.provider === "pi")
              .reduce((total, bucket) => total + bucket.costUsd, 0),
            45,
          );
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          assert.deepStrictEqual((yield* restarted.readSummary(WINDOW)).buckets, grown.buckets);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-fork",
              home,
              ratesDocument: {
                "actual-model": {
                  input_cost_per_token: 1,
                  output_cost_per_token: 4,
                  cache_read_input_token_cost: 0.1,
                  cache_creation_input_token_cost: 2,
                },
              },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("pi-extra")]: {
                    driver: ProviderDriverKind.make("pi"),
                    enabled: false,
                    environment: [
                      {
                        name: "PI_CODING_AGENT_DIR",
                        value: NodePath.join(home, "pi"),
                        sensitive: false,
                      },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "reads Muse inference history once, persists appended usage, and reprices unknown models",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const museHome = NodePath.join(home, "configured-data", "muse");
        const dir = NodePath.join(museHome, "sessions", "2026", "08", "01", "parent");
        const child = NodePath.join(dir, "subagent", "child");
        const entry = (
          id: string,
          sessionId = "parent",
          timestamp = "2026-08-01T00:00:00Z",
          model = "muse-unknown",
        ) => ({
          schema_version: 1,
          record_type: "event",
          payload_type: "runtime.session",
          payload_schema_version: 1,
          id,
          recorded_at: Date.parse(timestamp) * 1000 + 999,
          stream: { kind: "session", id: sessionId },
          payload: {
            source_run_record_id: id,
            event: {
              kind: "model_completed",
              model,
              usage: {
                input_tokens: 100,
                cached_tokens: 60,
                cache_read_tokens: 60,
                cache_write_tokens: 10,
                output_tokens: 20,
                reasoning_tokens: 8,
              },
            },
          },
        });
        const parent = entry("inference-1");
        const review = {
          ...entry("review", "child"),
          payload_schema_version: 3,
          payload: {
            event: {
              ...parent.payload.event,
              kind: "automated_review_completed",
              model: { model_id: "priced-model" },
              usage: {
                input_tokens: 100,
                cached_input_tokens: 60,
                output_tokens: 20,
                reasoning_tokens: 8,
              },
            },
          },
        };
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(child, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              parent,
              parent,
              {
                ...parent,
                payload: { event: { ...parent.payload.event, kind: "workflow_completed" } },
              },
              { ...parent, payload_type: "goal_usage_attribution" },
              entry("before", "parent", "2026-07-31T23:59:59.999Z"),
              entry("after", "parent", "2026-08-02T00:00:00Z"),
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n{broken}\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(child, "session.jsonl"),
            [
              { ...parent, id: "copied-envelope", stream: { kind: "session", id: "child" } },
              entry("child-inference", "child"),
              review,
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
          await NodeFSP.writeFile(
            NodePath.join(child, "telemetry.jsonl"),
            encodeUnknownJsonString(entry("not-a-session")) + "\n",
          );
        });
        using _create = vi.spyOn(MuseSdk, "createMuseSdkHostEffect").mockImplementation((options) =>
          Effect.succeed({
            initializeResult: {
              grantedCapabilities: [],
              museHome: NodePath.join(options.environment?.XDG_DATA_HOME ?? home, "muse"),
            },
            close: async () => {},
          } as unknown as MuseSdk.MuseSdkHost),
        );
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const window = {
            timeZone: "UTC",
            sinceDay: UsageDay.make("2026-08-01"),
            untilDay: UsageDay.make("2026-08-01"),
          };
          const muse = (summary: UsageSummary) =>
            summary.buckets.filter((bucket) => bucket.provider === "muse");
          const first = yield* service.readSummary(window);
          const buckets = muse(first);
          assert.strictEqual(
            buckets.reduce((sum, b) => sum + b.records, 0),
            3,
          );
          assert.strictEqual(
            buckets.reduce((sum, b) => sum + totalTokens(b.totals), 0),
            360,
          );
          const unknown = buckets.find((b) => b.model === "muse-unknown");
          assert.strictEqual(unknown?.costSource, "unpriced");
          assert.strictEqual(unknown?.unpricedRecords, 2);
          assert.deepStrictEqual(unknown?.totals, {
            uncachedInputTokens: 60,
            cachedInputTokens: 120,
            cacheCreationTokens: 20,
            outputTokens: 40,
            reasoningTokens: 16,
          });
          const priced = buckets.find((b) => b.model === "priced-model");
          assert.strictEqual(priced?.costSource, "modelPriced");
          assert.closeTo(priced?.costUsd ?? NaN, 0.000172, 1e-12);
          assert.closeTo(priced?.cacheSavingsUsd ?? NaN, 0.000108, 1e-12);
          const sources = first.sources.filter((source) => source.fingerprint.provider === "muse");
          assert.strictEqual(sources.length, 1);
          assert.strictEqual(sources[0]?.scannedFiles, 2);
          assert.strictEqual(sources[0]?.distinctSessions, 2);
          const local = muse(
            yield* service.readSummary({ ...window, timeZone: "America/Los_Angeles" }),
          );
          assert.strictEqual(
            local.reduce((sum, b) => sum + b.records, 0),
            1,
          );
          assert.strictEqual(local[0]?.day, "2026-08-01");
          const hourly = muse(
            yield* service.readSummary({
              ...window,
              resolution: "hour",
              sinceTime: "2026-08-01T00:00:00.000Z",
              untilTime: "2026-08-02T00:00:00.000Z",
            }),
          );
          assert.strictEqual(
            hourly.reduce((sum, b) => sum + b.records, 0),
            3,
          );
          const appended = encodeUnknownJsonString(entry("appended", "child"));
          const file = NodePath.join(child, "session.jsonl");
          yield* Effect.promise(() => NodeFSP.appendFile(file, appended.slice(0, -10)));
          assert.deepStrictEqual(muse(yield* service.readSummary(window)), buckets);
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          yield* Effect.promise(() => NodeFSP.appendFile(file, appended.slice(-10) + "\n"));
          const grown = muse(yield* restarted.readSummary(window));
          assert.strictEqual(
            grown.reduce((sum, b) => sum + b.records, 0),
            4,
          );
          assert.strictEqual(
            grown.reduce((sum, b) => sum + totalTokens(b.totals), 0),
            480,
          );
          const settingsService = yield* ServerSettings.ServerSettingsService;
          yield* settingsService.updateSettings({
            usagePriceOverrides: {
              "muse-unknown": {
                inputCostPerMillionTokens: 2,
                outputCostPerMillionTokens: 4,
                cacheReadCostPerMillionTokens: 0.2,
                cacheWriteCostPerMillionTokens: 1,
              },
            },
          });
          const repriced = muse(yield* restarted.readSummary(window)).find(
            (b) => b.model === "muse-unknown",
          );
          assert.strictEqual(repriced?.unpricedRecords, 0);
          assert.closeTo(repriced?.costUsd ?? NaN, 0.000486, 1e-12);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-muse",
              home,
              environment: { XDG_DATA_HOME: NodePath.dirname(museHome) },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("muse")]: {
                    driver: ProviderDriverKind.make("muse"),
                    enabled: false,
                  },
                  [ProviderInstanceId.make("muse-alias")]: {
                    driver: ProviderDriverKind.make("muse"),
                    enabled: false,
                  },
                },
              },
              ratesDocument: {
                "priced-model": {
                  input_cost_per_token: 0.000002,
                  output_cost_per_token: 0.000004,
                  cache_read_input_token_cost: 0.0000002,
                  cache_creation_input_token_cost: 0.0000002,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live("reports missing Pi history and skips malformed records without losing valid usage", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const missing = yield* service.readSummary(WINDOW);
        assert.strictEqual(
          missing.sources.find((source) => source.fingerprint.provider === "pi")?.status,
          "missing",
        );
        const dir = NodePath.join(home, "pi", "sessions");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              "{broken",
              "null",
              encodeUnknownJsonString({ type: "session", id: "valid" }),
              encodeUnknownJsonString({
                type: "message",
                id: "bad",
                timestamp: "invalid",
                message: {
                  role: "assistant",
                  provider: "openai",
                  model: "model",
                  usage: { input: 100 },
                },
              }),
              encodeUnknownJsonString({
                type: "message",
                id: "valid",
                timestamp: "2026-08-01T10:00:00Z",
                message: {
                  role: "assistant",
                  provider: "openai",
                  model: "model",
                  usage: {
                    input: -1,
                    cacheRead: "100",
                    output: 7,
                    reasoning: 50,
                    cost: { total: -1 },
                  },
                },
              }),
            ].join("\n") + "\n",
          );
        });
        const summary = yield* service.readSummary(WINDOW);
        const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
        assert.strictEqual(pi.length, 1);
        assert.strictEqual(pi[0] && totalTokens(pi[0].totals), 7);
        assert.strictEqual(pi[0]?.totals.reasoningTokens, 7);
        assert.strictEqual(pi[0]?.costSource, "unpriced");
      }).pipe(
        Effect.scoped,
        Effect.provide(layerService({ prefix: "usage-pi-malformed", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("discovers Pi history in its default home and directory overrides", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      for (const [agentDir, sessionDir, relativeDir] of [
        [undefined, undefined, ".pi/agent/sessions"],
        ["~/custom-pi", undefined, "custom-pi/sessions"],
        ["~/ignored-pi", "~/custom-sessions", "custom-sessions"],
        ["~/ignored-pi", NodePath.join(home, "absolute-sessions"), "absolute-sessions"],
      ] as const) {
        const dir = NodePath.join(home, relativeDir);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(dir, "session.jsonl"),
            [
              { type: "session", id: relativeDir },
              {
                type: "usage",
                id: "warm",
                timestamp: "2026-08-01T10:00:00Z",
                provider: "openai",
                model: "model",
                usage: { input: 7 },
              },
            ]
              .map((line) => encodeUnknownJsonString(line))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const summary = yield* service.readSummary(WINDOW);
          const pi = summary.buckets.filter((bucket) => bucket.provider === "pi");
          assert.strictEqual(pi.length, 1);
          assert.strictEqual(pi[0]?.totals.uncachedInputTokens, 7);
          assert.strictEqual(
            summary.sources.find((source) => source.fingerprint.provider === "pi")?.fingerprint
              .resolvedHomePath,
            dir,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-pi-" + relativeDir.replaceAll("/", "-"),
              home,
              settings,
              environment: {
                PI_CODING_AGENT_DIR: agentDir,
                PI_CODING_AGENT_SESSION_DIR: sessionDir,
              },
            }),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads shared managed default and disabled extra account history once", () =>
    Effect.gen(function* () {
      const { home, settings } = yield* setup;
      const summary = yield* Effect.gen(function* () {
        for (const [id, output] of [
          ["codex", 17],
          ["codex-personal", 23],
        ] as const) {
          const sessions = NodePath.join(home, "shared-codex", "sessions");
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(sessions, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(sessions, `${id}-rollout.jsonl`),
              [
                { type: "session_meta", payload: { id } },
                { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
                {
                  type: "event_msg",
                  timestamp: "2026-08-01T10:00:00Z",
                  payload: {
                    type: "token_count",
                    info: { last_token_usage: { input_tokens: 10, output_tokens: output } },
                  },
                },
              ]
                .map((line) => encodeUnknownJsonString(line))
                .join("\n") + "\n",
            );
          });
        }
        const service = yield* UsageService.make;
        return yield* service.readSummary(WINDOW);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-managed-accounts",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: {
                    setupMode: "managed",
                    homePath: NodePath.join(home, "shared-codex"),
                  },
                },
                [ProviderInstanceId.make("codex-personal")]: {
                  driver: ProviderDriverKind.make("codex"),
                  enabled: false,
                  config: {
                    setupMode: "managed",
                    homePath: NodePath.join(home, "shared-codex"),
                    shadowHomePath: NodePath.join(home, "personal-shadow"),
                  },
                  environment: [
                    {
                      name: "CODEX_HOME",
                      value: NodePath.join(home, "ignored-environment"),
                      sensitive: false,
                    },
                  ],
                },
              },
            },
          }),
        ),
      );
      assert.strictEqual(totalOutputTokens(summary), 40);
      assert.strictEqual(
        summary.sources.filter(
          (source) => source.fingerprint.provider === "codex" && source.status === "ok",
        ).length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps Cursor credential errors visible when a saved login cannot be read", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const authPath = NodePath.join(home, "config", "cursor", "auth.json");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
        await NodeFSP.writeFile(authPath, "invalid json");
      });
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
        assert.strictEqual(cursor?.message, "Cursor credentials could not be read.");
      }).pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-cursor-invalid-login", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reuses one transcript stat pass through a Cursor refresh follow-up", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* writeCursorLogin(home);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const cursor = makeFakeCursor();
      const release = yield* Deferred.make<void>();
      cursor.state.gate = release;
      cursor.state.events = [{ timestampMs: CURSOR_NOW - HOUR_MS, outputTokens: 7 }];
      yield* Effect.gen(function* () {
        const service = yield* makeWithCursor(cursor.read);
        using stat = vi.spyOn(NodeFSP, "stat");
        const canonical = yield* Effect.promise(() => NodeFSP.realpath(transcript));
        const initial = yield* service.readSummary(WINDOW);
        assert.isTrue(cursorSource(initial)?.refreshing);
        assert.strictEqual(totalOutputTokens(initial), 5);

        const waiter = yield* service
          .readSummary({ ...WINDOW, awaitRefresh: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        const partial = yield* Fiber.join(waiter);
        assert.strictEqual(partial.partialReason, "scanTimedOut");
        assert.strictEqual(totalOutputTokens(partial), 5);
        assert.isUndefined(cursorSource(partial)?.refreshing);

        yield* Deferred.succeed(release, undefined);
        const refreshed = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.strictEqual(totalOutputTokens(refreshed), 12);
        assert.isUndefined(refreshed.partialReason);
        assert.lengthOf(cursor.state.calls, 1);
        assert.lengthOf(
          stat.mock.calls.filter(([file]) => file === canonical),
          1,
        );
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-shared-followup", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    "returns completed transcript totals when a provider stalls in its first collection",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* writeCursorLogin(home);
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const snapshot = Promise.withResolvers<void>();
          const base = yield* Effect.tracer;
          const tracer = Tracer.make({
            span(options) {
              const span = base.span(options);
              if (options.name === "UsageService.finishSummary") {
                const end = span.end.bind(span);
                span.end = (endTime, exit) => {
                  end(endTime, exit);
                  snapshot.resolve();
                };
              }
              return span;
            },
          });
          const service = yield* makeWithCursor(makeFakeCursor().read).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                file.endsWith("usage-cursor-account-cache-v1.json")
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(fs.readFileString(file, encoding)),
                    )
                  : fs.readFileString(file, encoding),
            }),
          );
          const pending = yield* service
            .readSummary(WINDOW)
            .pipe(Effect.withTracer(tracer), Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Effect.promise(() => snapshot.promise);
          yield* TestClock.adjust("30 seconds");
          const partial = yield* Fiber.join(pending);
          assert.strictEqual(partial.partialReason, "scanTimedOut");
          assert.strictEqual(totalOutputTokens(partial), 5);
          yield* Deferred.succeed(release, undefined);
          const finished = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
          assert.isUndefined(finished.partialReason);
          assert.strictEqual(totalOutputTokens(finished), 5);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-source-deadline", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["stalls", "interrupts"] as const)(
    "recovers when the Codex tier resolver %s",
    (mode) =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const sessions = NodePath.join(home, "codex", "sessions");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(sessions, "run.jsonl"),
            [
              { type: "session_meta", payload: { id: "session", model_provider: "openai" } },
              { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "turn" } },
              {
                type: "event_msg",
                timestamp: "2026-08-01T10:00:00Z",
                payload: {
                  type: "token_count",
                  info: { last_token_usage: { input_tokens: 0, output_tokens: 7 } },
                },
              },
            ]
              .map((record) => encodeUnknownJsonString(record))
              .join("\n") + "\n",
          );
        });
        yield* Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let calls = 0;
          const service = yield* UsageService.make.pipe(
            Effect.provideService(CodexUsageHistory.CodexUsageHistory, {
              resolve: (requests) =>
                Effect.suspend(() => {
                  calls++;
                  if (mode === "interrupts") {
                    return calls === 1
                      ? Effect.interrupt
                      : Effect.succeed(
                          new Map(requests.map((request) => [request, "fast"] as const)),
                        );
                  }
                  return Effect.void.pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(new Map(requests.map((request) => [request, "fast"] as const))),
                  );
                }),
            }),
          );
          if (mode === "interrupts") {
            assert.strictEqual(
              (yield* Effect.flip(service.readSummary(WINDOW))).reason,
              "scanFailed",
            );
            const independent = yield* service.readSummary({
              ...WINDOW,
              timeZone: "America/New_York",
            });
            assert.strictEqual(totalOutputTokens(independent), 7);
            assert.strictEqual(calls, 2);
            return;
          }
          const pending = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("30 seconds");
          const partial = yield* Fiber.join(pending);
          assert.strictEqual(partial.partialReason, "scanTimedOut");
          assert.strictEqual(totalOutputTokens(partial), 7);
          assert.strictEqual(calls, 1);
          const retry = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* Deferred.succeed(release, undefined);
          assert.isUndefined((yield* Fiber.join(retry)).partialReason);
          assert.strictEqual(calls, 1);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-tier-deadline", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("includes settings and cache loading in the caller deadline", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const old = yield* UsageService.make;
        yield* old.readSummary(WINDOW);
        yield* old.awaitPersisted;
        const settingsStarted = yield* Deferred.make<void>();
        const cacheStarted = yield* Deferred.make<void>();
        const releaseSettings = yield* Deferred.make<void>();
        const releaseCache = yield* Deferred.make<void>();
        const originalSettings = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, {
            ...originalSettings,
            getSettings: Deferred.succeed(settingsStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSettings)),
              Effect.andThen(originalSettings.getSettings),
            ),
          }),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, encoding) =>
              NodePath.dirname(file) === storeDirOf(stateDir)
                ? Deferred.succeed(cacheStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseCache)),
                    Effect.andThen(fs.readFileString(file, encoding)),
                  )
                : fs.readFileString(file, encoding),
          }),
        );
        const waitingSettings = yield* service
          .readSummary(WINDOW)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(settingsStarted);
        yield* TestClock.adjust("30 seconds");
        assert.strictEqual((yield* Fiber.join(waitingSettings))._tag, "Failure");

        const waitingCache = yield* service
          .readSummary(WINDOW)
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("12 seconds");
        yield* Deferred.succeed(releaseSettings, undefined);
        yield* Deferred.await(cacheStarted);
        yield* TestClock.adjust("18 seconds");
        const cacheResult = yield* Fiber.join(waitingCache);
        assert.strictEqual(
          cacheResult._tag === "Failure" && cacheResult.failure.reason,
          "scanPending",
        );
        yield* Deferred.succeed(releaseCache, undefined);
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 5);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-startup-deadline", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("expires a blocked Cursor credential read and allows a fresh refresh", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.gen(function* () {
        const began = yield* Deferred.make<void>();
        const cursor = makeFakeCursor();
        cursor.state.events = [{ timestampMs: CURSOR_NOW - HOUR_MS, outputTokens: 7 }];
        let attempts = 0;
        const service = yield* makeWithCursor((...args) =>
          Effect.suspend(() => {
            attempts++;
            return attempts === 1
              ? Deferred.succeed(began, undefined).pipe(Effect.andThen(Effect.never))
              : cursor.read(...args);
          }),
        );
        assert.isTrue(cursorSource(yield* service.readSummary(WINDOW))?.refreshing);
        yield* Deferred.await(began);
        yield* TestClock.adjust("119 seconds");
        const expiring = yield* service
          .readSummary({ ...WINDOW, awaitRefresh: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        const expired = yield* Fiber.join(expiring);
        assert.strictEqual(
          cursorSource(expired)?.message,
          "Cursor account usage could not be read.",
        );
        assert.isUndefined(expired.partialReason);
        assert.strictEqual(attempts, 1);
        yield* TestClock.adjust("1 minute");
        const recovered = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.strictEqual(attempts, 2);
        assert.strictEqual(totalOutputTokens(recovered), 7);
      }).pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-cursor-credential-deadline", home, settings }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("restores the Cursor account cache after a restart", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      yield* writeCursorLogin(home);
      yield* TestClock.setTime(CURSOR_NOW);
      const before = makeFakeCursor();
      before.state.events = [
        { timestampMs: CURSOR_NOW - 30 * HOUR_MS, outputTokens: 5 },
        { timestampMs: CURSOR_NOW - 3 * HOUR_MS, outputTokens: 7 },
      ];
      yield* Effect.gen(function* () {
        const first = yield* makeWithCursor(before.read);
        const original = yield* first.readSummary({ ...WINDOW, awaitRefresh: true });
        yield* first.awaitPersisted;

        const after = makeFakeCursor();
        after.state.events = before.state.events;
        const restarted = yield* makeWithCursor(after.read);
        const restored = yield* restarted.readSummary(WINDOW);
        assert.isUndefined(cursorSource(restored)?.refreshing);
        assert.deepStrictEqual(restored.buckets, original.buckets);
        assert.deepStrictEqual(cursorSource(restored), cursorSource(original));
        assert.strictEqual(after.state.calls.length, 0);

        yield* TestClock.adjust(Duration.minutes(2));
        const refreshed = yield* restarted.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.deepStrictEqual(refreshed.buckets, original.buckets);
        assert.deepStrictEqual(after.state.calls, [
          { sinceMs: CURSOR_NOW - HOUR_MS, untilMs: CURSOR_NOW + 2 * 60 * 1000 },
        ]);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-cursor-restart", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not read the macOS Cursor Keychain before account usage is enabled", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-cursor-keychain-disabled",
            home,
            settings,
            platform: "darwin",
            environment: {},
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
      assert.strictEqual(cursor?.status, "missing");
      assert.strictEqual(cursor?.action, "enableCursorKeychain");
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a stale macOS Keychain login when Cursor is not installed", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const cursor = makeFakeCursor();
      cursor.state.error = "Sign in to Cursor again to read account usage.";
      const readCursorSource = Effect.gen(function* () {
        const service = yield* makeWithCursor(cursor.read);
        const summary = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        return cursorSource(summary);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-cursor-keychain-uninstalled",
            home,
            settings: { ...settings, cursorKeychainUsageEnabled: true },
            platform: "darwin",
            environment: {},
          }),
        ),
      );

      assert.isUndefined(yield* readCursorSource);
      assert.lengthOf(cursor.state.calls, 0);

      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(home, ".cursor")));
      const installed = yield* readCursorSource;
      assert.strictEqual(installed?.message, "Sign in to Cursor again to read account usage.");
      assert.lengthOf(cursor.state.calls, 1);
    }).pipe(Effect.scoped),
  );

  it.live("ignores stale Cursor file logins when the active credential store differs", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      for (const [index, testCase] of [
        {
          platform: "darwin" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: [".cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { AGENT_CLI_CREDENTIAL_STORE: "memory" },
          authPath: ["config", "cursor", "auth.json"],
        },
        {
          platform: "linux" as const,
          environment: { CURSOR_API_KEY: "different-account" },
          authPath: ["config", "cursor", "auth.json"],
        },
      ].entries()) {
        const authPath = NodePath.join(home, ...testCase.authPath);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
          await NodeFSP.writeFile(
            authPath,
            encodeUnknownJsonString({ accessToken: "stale-token" }),
          );
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: `usage-service-cursor-store-${index}`,
              home,
              settings,
              platform: testCase.platform,
              environment: testCase.environment,
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        const cursor = summary.sources.find((source) => source.fingerprint.provider === "cursor");
        assert.strictEqual(cursor?.status, "missing");
        assert.include(cursor?.message ?? "", "Cursor CLI login");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
      }
    }).pipe(Effect.scoped),
  );

  it.live(
    "includes OpenCode history but does not substitute desktop usage for an unavailable Cursor account",
    () =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        const root = NodePath.join(home, "opencode");
        const message = yield* encodeUnknownJson({
          id: "msg_1",
          sessionID: "session-1",
          role: "assistant",
          modelID: "example-model",
          time: { created: Date.parse("2026-08-01T10:00:00Z") },
          tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 20, write: 3 } },
        });
        const bubble = yield* encodeUnknownJson({
          type: 2,
          createdAt: "2026-08-01T10:00:00Z",
          modelInfo: { modelName: "example-model" },
          tokenCount: { inputTokens: 100, outputTokens: 20 },
        });
        yield* Effect.promise(async () => {
          const directory = NodePath.join(root, "storage", "message", "session-1");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(directory, "msg_1.json"), message);
          const desktop = NodePath.join(home, "config", "Cursor", "User", "globalStorage");
          await NodeFSP.mkdir(desktop, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(NodePath.join(desktop, "state.vscdb"));
          try {
            db.exec("CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
            db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(
              "bubbleId:session:assistant",
              bubble,
            );
          } finally {
            db.close();
          }
        });
        const service = yield* UsageService.make.pipe(
          Effect.provide(layerService({ prefix: "usage-service-opencode", home, settings })),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(summary.buckets[0]?.provider, "opencode");
        assert.isFalse(summary.buckets.some((bucket) => bucket.provider === "cursor"));
        assert.isFalse(summary.sources.some((source) => source.fingerprint.provider === "cursor"));
        assert.strictEqual(
          summary.buckets[0]?.sourcePath,
          yield* Effect.promise(() => NodeFSP.realpath(root)),
        );
        assert.strictEqual(summary.buckets[0]?.totals.outputTokens, 7);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "opencode")
            ?.distinctSessions,
          1,
        );
      }).pipe(Effect.scoped),
  );

  it.live("includes host and merged OpenCode instance histories once across list aliases", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const hostRoot = NodePath.join(home, "opencode");
      const instanceRoot = NodePath.join(home, "opencode-work");
      const alias = NodePath.join(home, "opencode-alias");
      const dataHome = NodePath.join(home, "data");
      const xdgRoot = NodePath.join(dataHome, "opencode");
      const histories = [
        { root: hostRoot, id: "host", output: 5 },
        { root: instanceRoot, id: "work", output: 7 },
        { root: xdgRoot, id: "xdg", output: 11 },
      ];
      yield* Effect.promise(async () => {
        for (const { root, id, output } of histories) {
          const directory = NodePath.join(root, "storage", "message", "session-1");
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(directory, `${id}.json`),
            encodeUnknownJsonString({
              role: "assistant",
              modelID: "example-model",
              time: { created: Date.parse("2026-08-01T10:00:00Z") },
              tokens: { input: 10, output },
            }),
          );
        }
        await NodeFSP.symlink(instanceRoot, alias, "junction");
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-opencode-instances",
            home,
            environment: { XDG_DATA_HOME: dataHome },
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("opencode-work")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  environment: [
                    {
                      name: "OPENCODE_DATA_DIR",
                      value: ` ${instanceRoot}, ${alias} `,
                      sensitive: false,
                    },
                  ],
                },
                [ProviderInstanceId.make("opencode-xdg")]: {
                  driver: ProviderDriverKind.make("opencode"),
                  environment: [{ name: "OPENCODE_DATA_DIR", value: "", sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sources = summary.sources.filter(
        (source) => source.fingerprint.provider === "opencode",
      );
      const expectedRoots = yield* Effect.promise(() =>
        Promise.all(histories.map(({ root }) => NodeFSP.realpath(root))),
      );
      assert.deepStrictEqual(
        sources.map((source) => source.fingerprint.resolvedHomePath).sort(),
        expectedRoots.sort(),
      );
      assert.deepStrictEqual(
        summary.buckets
          .filter((bucket) => bucket.provider === "opencode")
          .map((bucket) => bucket.totals.outputTokens)
          .sort((a, b) => a - b),
        [5, 7, 11],
      );
    }).pipe(Effect.scoped),
  );

  it.live("counts aliased OpenCode and Antigravity directories once", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const opencode = NodePath.join(home, "opencode-store");
      const opencodeAlias = NodePath.join(home, "opencode-alias");
      const conversations = NodePath.join(home, "antigravity-conversations");
      const antigravityA = NodePath.join(home, "antigravity-a");
      const antigravityB = NodePath.join(home, "antigravity-b");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(opencode);
        await NodeFSP.symlink(opencode, opencodeAlias, "junction");
        await NodeFSP.mkdir(conversations);
        await NodeFSP.mkdir(antigravityA);
        await NodeFSP.mkdir(antigravityB);
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityA, "conversations"),
          "junction",
        );
        await NodeFSP.symlink(
          conversations,
          NodePath.join(antigravityB, "conversations"),
          "junction",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-aliased-roots-test",
            home,
            settings,
            environment: {
              OPENCODE_DATA_DIR: `${opencode},${opencodeAlias}`,
              ANTIGRAVITY_DATA_DIR: `${antigravityA},${antigravityB}`,
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const sourcesFor = (provider: "opencode" | "antigravity") =>
        summary.sources.filter((source) => source.fingerprint.provider === provider);
      assert.strictEqual(sourcesFor("opencode").length, 1);
      assert.strictEqual(sourcesFor("antigravity").length, 1);
      assert.strictEqual(
        sourcesFor("opencode")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(opencode)),
      );
      assert.strictEqual(
        sourcesFor("antigravity")[0]?.fingerprint.resolvedHomePath,
        yield* Effect.promise(() => NodeFSP.realpath(conversations)),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reads Antigravity history from each instance's data directory", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const prefix = "usage-service-antigravity-instances-test";
      const first = NodePath.join(home, "antigravity-first");
      const second = NodePath.join(home, "antigravity-second");
      const { profile } = yield* resolveAntigravityInstanceDirectories(
        NodePath.join(home, prefix, "userdata"),
        ProviderInstanceId.make("antigravity"),
      ).pipe(Effect.provide(NodeServices.layer));
      const histories = [
        [first, 7],
        [second, 11],
        [NodePath.join(profile, "antigravity-acp", "conversations"), 13],
      ] as const;
      yield* Effect.promise(async () => {
        for (const [dir, outputTokens] of histories) {
          await NodeFSP.mkdir(dir, { recursive: true });
          const db = new NodeSqlite.DatabaseSync(
            NodePath.join(dir, `${NodePath.basename(dir)}.db`),
          );
          try {
            db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
            // Step protobuf: 100 input tokens, distinct output tokens, and 2026-08-01T10:00Z.
            const metadata = new Uint8Array([
              0x4a,
              4,
              0x10,
              100,
              0x18,
              outputTokens,
              ...Buffer.from("420608a087b7d306", "hex"),
            ]);
            db.prepare("INSERT INTO steps VALUES (?, ?)").run(0, metadata);
          } finally {
            db.close();
          }
        }
      });
      const instance = (dataDir: string) => ({
        driver: ProviderDriverKind.make("antigravity"),
        environment: [{ name: "ANTIGRAVITY_DATA_DIR", value: dataDir, sensitive: false }],
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix,
            home,
            settings: {
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("antigravity-first")]: instance(first),
                [ProviderInstanceId.make("antigravity-second")]: instance(` ${second}, `),
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      const roots = summary.sources
        .filter((source) => source.fingerprint.provider === "antigravity")
        .map((source) => source.fingerprint.resolvedHomePath);
      for (const [dir, outputTokens] of histories) {
        const root = yield* Effect.promise(() => NodeFSP.realpath(dir));
        assert.include(roots, root);
        assert.strictEqual(
          summary.buckets
            .filter((bucket) => bucket.provider === "antigravity" && bucket.sourcePath === root)
            .reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
          outputTokens,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.live("reads configured and disabled accounts once across shared and aliased homes", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const codexHome = NodePath.join(home, "codex-account");
      const alias = NodePath.join(home, "codex-alias");
      const claudeHome = NodePath.join(home, "claude-account");
      const grokHome = NodePath.join(home, "grok-account");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.mkdir(NodePath.join(claudeHome, "projects"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(claudeHome, "projects", "session.jsonl"),
          claudeLine(2, 7),
        );
        await NodeFSP.mkdir(NodePath.join(codexHome, "sessions"), { recursive: true });
        await NodeFSP.symlink(codexHome, alias, "junction");
        await NodeFSP.writeFile(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          [
            { type: "session_meta", payload: { id: "codex-account-session" } },
            { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
            ...[11, 12, 11].map((outputTokens) => ({
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
              },
            })),
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n",
        );
        await NodeFSP.mkdir(NodePath.join(grokHome, "sessions", "session"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(grokHome, "sessions", "session", "updates.jsonl"),
          encodeUnknownJsonString({
            timestamp: Date.parse("2026-08-01T10:00:00Z") / 1000,
            method: "_x.ai/session/update",
            params: {
              sessionId: "grok-account-session",
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: "prompt-1",
                usage: { inputTokens: 10, outputTokens: 13 },
              },
            },
          }) + "\n",
        );
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-accounts-test",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("claude-work")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                  environment: [{ name: "CLAUDE_CONFIG_DIR", value: claudeHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-work")]: {
                  driver: ProviderDriverKind.make("codex"),
                  environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
                },
                [ProviderInstanceId.make("codex-alias")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: alias },
                },
                [ProviderInstanceId.make("codex-shadow")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome, shadowHomePath: NodePath.join(home, "shadow") },
                  environment: [
                    { name: "CODEX_HOME", value: NodePath.join(home, "ignored"), sensitive: false },
                  ],
                },
                [ProviderInstanceId.make("grok-work")]: {
                  driver: ProviderDriverKind.make("grok"),
                  config: { customModels: "not-a-list" },
                  environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
                },
              },
            },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 59);
      yield* Effect.promise(() =>
        NodeFSP.rename(
          NodePath.join(codexHome, "sessions", "rollout.jsonl"),
          NodePath.join(codexHome, "sessions", "moved.jsonl"),
        ),
      );
      const moved = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(moved.buckets, summary.buckets);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(codexHome, "sessions"), { recursive: true }),
      );
      const removed = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(removed.buckets, summary.buckets);

      const sources = summary.sources.filter((source) => source.status === "ok");
      assert.strictEqual(sources.length, 4);
      assert.strictEqual(
        sources.reduce((sum, source) => sum + source.scannedFiles, 0),
        4,
      );
      assert.strictEqual(
        sources.filter((source) => source.fingerprint.provider === "codex").length,
        1,
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "uses explicit account settings before environment and default homes, then refreshes them",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const configured = NodePath.join(home, "configured");
        const environmentHome = NodePath.join(home, "environment");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 100));
          for (const [index, root] of [configured, environmentHome].entries()) {
            await NodeFSP.mkdir(NodePath.join(root, "projects"), { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(root, "projects", "session.jsonl"),
              claudeLine(index + 2, index + 7),
            );
          }
          await NodeFSP.mkdir(NodePath.join(configured, ".claude", "projects"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(configured, ".claude", "projects", "wrong.jsonl"),
            claudeLine(4, 1000),
          );
        });
        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 7);
          const configuredProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(configured, "projects")),
          );
          assert.include(
            first.sources.map((source) => source.fingerprint.resolvedHomePath),
            configuredProjects,
          );
          yield* settingsService.updateSettings({
            providerInstances: {
              ...settings.providerInstances,
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: "" },
                environment: [
                  { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                ],
              },
            },
          });
          const second = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(second), 8);
          const environmentProjects = yield* Effect.promise(() =>
            NodeFSP.realpath(NodePath.join(environmentHome, "projects")),
          );
          assert.include(
            second.sources.map((source) => source.fingerprint.resolvedHomePath),
            environmentProjects,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-home-refresh-test",
              home,
              environment: { CLAUDE_CONFIG_DIR: NodePath.join(home, "host-ignored") },
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: configured },
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: environmentHome, sensitive: false },
                    ],
                  },
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "uses inherited home variables when explicit default accounts have no home settings",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const inheritedCodexHome = NodePath.join(home, "inherited-codex ");
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const service = yield* UsageService.make.pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-inherited-homes-test",
              home,
              environment: {
                CODEX_HOME: inheritedCodexHome,
                CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
              },
              settings: {
                ...settings,
                providerInstances: {
                  [ProviderInstanceId.make("codex")]: {
                    driver: ProviderDriverKind.make("codex"),
                    config: {},
                  },
                  [ProviderInstanceId.make("claudeAgent")]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: {},
                  },
                },
              },
            }),
          ),
        );
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "codex")?.fingerprint
            .resolvedHomePath,
          NodePath.join(inheritedCodexHome, "sessions"),
        );
        assert.strictEqual(
          summary.sources.find((source) => source.fingerprint.provider === "grok")?.fingerprint
            .resolvedHomePath,
          NodePath.join(home, "grok", "sessions"),
        );
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "reports unreadable transcripts as partial and recovers once they can be read",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const folder = NodePath.dirname(transcript);
        const sourceDir = NodePath.dirname(folder);
        const unreadable = NodePath.join(folder, "other.jsonl");
        const sibling = NodePath.join(sourceDir, "sibling");
        yield* TestClock.setTime(CURSOR_NOW);
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 5));
          await NodeFSP.writeFile(unreadable, claudeLine(2, 7));
          await NodeFSP.chmod(unreadable, 0);
          await NodeFSP.mkdir(sibling);
        });
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const denied = new Set<string>();
        let removeBeforeOpen = false;
        using _readdir = vi.spyOn(NodeFSP, "readdir").mockImplementation(async (...args) => {
          if (typeof args[0] === "string" && denied.has(args[0])) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return actual.readdir(...args);
        });
        using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
          if (removeBeforeOpen && args[0] === unreadable) {
            removeBeforeOpen = false;
            await actual.rm(unreadable);
          }
          return actual.open(...args);
        });
        const logs = captureLogs();
        const failures = () =>
          logs.of("Error", "Could not read transcript usage").map((fields) => {
            const { path, cause } = fields as { path: string; cause: NodeJS.ErrnoException };
            return { path, code: cause.code };
          });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          for (let scan = 0; scan < 2; scan++) {
            const partial = yield* service.readSummary(WINDOW);
            assert.strictEqual(totalOutputTokens(partial), 5);
            assert.strictEqual(partial.sources[0]?.status, "partial");
            yield* TestClock.adjust("5 seconds");
          }
          assert.deepStrictEqual(failures(), [{ path: unreadable, code: "EACCES" }]);

          denied.add(folder);
          assert.strictEqual((yield* service.readSummary(WINDOW)).sources[0]?.status, "partial");
          denied.delete(folder);
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual((yield* service.readSummary(WINDOW)).sources[0]?.status, "partial");
          assert.deepStrictEqual(failures(), [
            { path: unreadable, code: "EACCES" },
            { path: folder, code: "EACCES" },
          ]);
          yield* TestClock.adjust("5 seconds");

          // A sibling that still fails cannot hide the folder, so the folder read again, and its
          // next failure is news.
          const logCount = (failedPath: string) =>
            failures().filter(({ path }) => path === failedPath).length;
          for (const deniedNow of [[folder, sibling], [sibling], [folder, sibling]]) {
            denied.clear();
            for (const dir of deniedNow) denied.add(dir);
            assert.strictEqual((yield* service.readSummary(WINDOW)).sources[0]?.status, "partial");
            yield* TestClock.adjust("5 seconds");
          }
          denied.clear();
          assert.deepStrictEqual(
            {
              unreadable: logCount(unreadable),
              folder: logCount(folder),
              sibling: logCount(sibling),
            },
            { unreadable: 1, folder: 3, sibling: 1 },
          );

          yield* Effect.promise(() => NodeFSP.chmod(unreadable, 0o600));
          const healthy = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(healthy), 12);
          assert.strictEqual(healthy.sources[0]?.status, "ok");
          assert.isNull(healthy.sources[0]?.message);

          yield* Effect.promise(async () => {
            await NodeFSP.appendFile(unreadable, claudeLine(3, 11));
            await NodeFSP.chmod(unreadable, 0);
          });
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual((yield* service.readSummary(WINDOW)).sources[0]?.status, "partial");
          assert.lengthOf(failures(), 6);

          yield* Effect.promise(() => NodeFSP.rename(sourceDir, `${sourceDir}-away`));
          yield* TestClock.adjust("5 seconds");
          yield* service.readSummary(WINDOW);
          yield* Effect.promise(() => NodeFSP.rename(`${sourceDir}-away`, sourceDir));
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual((yield* service.readSummary(WINDOW)).sources[0]?.status, "partial");
          assert.lengthOf(failures(), 7);

          removeBeforeOpen = true;
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual((yield* service.readSummary(WINDOW)).sources[0]?.status, "ok");
          assert.lengthOf(failures(), 7);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerService({ prefix: "usage-service-unreadable", home, settings }),
              logs.layer,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("shares warm stats and only retries a partial directory walk after the TTL", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const root = yield* Effect.promise(() =>
        NodeFSP.realpath(NodePath.join(home, "claude", "projects")),
      );
      const failed = NodePath.join(root, "unreadable");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(failed);
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.writeFile(NodePath.join(failed, "extra.jsonl"), claudeLine(2, 7));
      });
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      const canonical = yield* Effect.promise(() => NodeFSP.realpath(transcript));
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let denied = true;
      let hold = false;
      let failedWalks = 0;
      let warmStats = 0;
      using _readdir = vi.spyOn(NodeFSP, "readdir").mockImplementation(async (...args) => {
        if (args[0] === failed) {
          failedWalks++;
          if (denied) throw new Error("permission denied");
        }
        return actual.readdir(...args);
      });
      using _stat = vi.spyOn(NodeFSP, "stat").mockImplementation(async (...args) => {
        if (args[0] === canonical && hold) {
          warmStats++;
          started.resolve();
          await release.promise;
        }
        return actual.stat(...args);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));

      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(first.sources[0]?.status, "partial");
        assert.strictEqual(totalOutputTokens(first), 5);

        hold = true;
        const one = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        const two = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        release.resolve();
        const warm = yield* Fiber.join(one);
        assert.strictEqual(warm, yield* Fiber.join(two));
        assert.strictEqual(warm.sources[0]?.status, "partial");
        assert.strictEqual(warmStats, 1);
        assert.strictEqual(failedWalks, 1);

        hold = false;
        denied = false;
        yield* TestClock.adjust("5 seconds");
        const healthy = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(healthy), 12);
        assert.strictEqual(healthy.sources[0]?.status, "ok");
        assert.strictEqual(failedWalks, 2);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-partial-listing", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("filters original model IDs before aliases, pricing, buckets and session counts", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          claudeLine(1, 3, "orbit-1", "mixed") +
            claudeLine(2, 5, "orbit-2", "mixed") +
            claudeLine(3, 7, "drift-9", "mixed") +
            claudeLine(4, 11, "drift-9", "excluded-only"),
        ),
      );
      const rates = {
        "orbit-1": { input_cost_per_token: 0.000001, output_cost_per_token: 0.00001 },
        "orbit-2": { input_cost_per_token: 0.000002, output_cost_per_token: 0.00002 },
      };
      const include = {
        // The codex selector must not match the Claude drift-9 records.
        include: [
          { provider: "claude", model: "orbit-1" },
          { model: "orbit-2" },
          { provider: "codex", model: "drift-9" },
        ],
      };
      const exclude = { exclude: [{ model: "drift-9" }] };
      const HOURLY: UsageSummaryInput = {
        ...WINDOW,
        resolution: "hour",
        sinceTime: "2026-08-01T09:00:00Z",
        untilTime: "2026-08-01T11:00:00Z",
      };
      const cells = (summary: UsageSummary) =>
        summary.buckets.map(({ model, totals, costUsd, records, sessions }) => ({
          model,
          outputTokens: totals.outputTokens,
          costUsd: Math.round(costUsd * 1e6),
          records,
          sessions,
        }));

      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        // Same service, concurrent reads: the in-flight key must keep these scans apart.
        const [unfiltered, noOp, keepNothing, included, reordered, excluded, hourly] =
          yield* Effect.all(
            [
              service.readSummary(WINDOW),
              service.readSummary({ ...WINDOW, modelFilter: { exclude: [] } }),
              service.readSummary({ ...WINDOW, modelFilter: { include: [] } }),
              service.readSummary({ ...WINDOW, modelFilter: include }),
              service.readSummary({
                ...WINDOW,
                modelFilter: { include: [...include.include].reverse() },
              }),
              service.readSummary({ ...WINDOW, modelFilter: exclude }),
              service.readSummary({ ...HOURLY, modelFilter: include }),
            ],
            { concurrency: "unbounded" },
          );

        // Unfiltered keeps today's behavior: the alias folds drift-9 into orbit-1.
        assert.deepStrictEqual(cells(unfiltered), [
          { model: "orbit-1", outputTokens: 21, costUsd: 240, records: 3, sessions: 2 },
          { model: "orbit-2", outputTokens: 5, costUsd: 120, records: 1, sessions: 1 },
        ]);
        assert.strictEqual(unfiltered.sources[0]?.distinctSessions, 2);
        assert.strictEqual(unfiltered.modelFilter, undefined);
        assert.strictEqual(noOp, unfiltered);
        assert.deepStrictEqual(keepNothing.buckets, []);
        assert.strictEqual(keepNothing.sources[0]?.distinctSessions, 0);

        const kept = [
          { model: "orbit-1", outputTokens: 3, costUsd: 40, records: 1, sessions: 1 },
          { model: "orbit-2", outputTokens: 5, costUsd: 120, records: 1, sessions: 1 },
        ];
        assert.deepStrictEqual(cells(included), kept);
        assert.deepStrictEqual(cells(excluded), kept);
        assert.deepStrictEqual(cells(hourly), kept);
        assert.strictEqual(hourly.buckets[0]?.hourStart, "2026-08-01T10:00:00.000Z");
        for (const summary of [included, excluded, hourly]) {
          assert.strictEqual(summary.sources[0]?.distinctSessions, 1);
        }
        // Equal filters share one scan and echo one canonical form.
        assert.strictEqual(reordered, included);
        assert.deepStrictEqual(included.modelFilter, {
          include: [
            { provider: "claude", model: "orbit-1" },
            { provider: "codex", model: "drift-9" },
            { model: "orbit-2" },
          ],
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-service-model-filter-test",
            home,
            settings: { ...settings, usageModelAliases: { "drift-9": "orbit-1" } },
            ratesDocument: rates,
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("meters each API history home once and exposes unpriced records", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          claudeLine(0, 500, "example-model").replace(
            "2026-08-01T10:00:00Z",
            "2026-07-31T10:00:00Z",
          ) +
            claudeLine(1, 5, "example-model") +
            claudeLine(2, 5, "unknown-model"),
        ),
      );
      const primary = ProviderInstanceId.make("claudeAgent");
      const alias = ProviderInstanceId.make("claude_api_alias");
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const spend = yield* service.readAccountSpend(
          [primary, alias].map((instanceId) => ({ instanceId, since: "2026-08-01T00:00:00Z" })),
        );
        assert.closeTo(spend.get(primary)?.spendUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(spend.get(primary)?.unpricedUsage, true);
        assert.deepStrictEqual(spend.get(alias), {
          spendUsd: null,
          unpricedUsage: false,
          sharedWith: primary,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-api-spend",
            home,
            settings: {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [alias]: settings.providerInstances[primary]!,
              },
              usagePriceOverrides: {
                "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
              },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reprices unchanged transcripts when custom prices are added, edited, or removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;

        const original = yield* service.readSummary(WINDOW);
        assert.strictEqual(original.buckets[0]?.costUsd, 0);
        assert.strictEqual(original.buckets[0]?.unpricedRecords, 1);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        const overridden = yield* service.readSummary(WINDOW);
        assert.closeTo(overridden.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
        assert.strictEqual(overridden.buckets[0]?.costSource, "modelPriced");
        assert.strictEqual(overridden.buckets[0]?.unpricedRecords, 0);
        assert.deepStrictEqual(overridden.buckets[0]?.totals, original.buckets[0]?.totals);

        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 16 },
          },
        });
        const edited = yield* service.readSummary(WINDOW);
        assert.closeTo(edited.buckets[0]?.costUsd ?? -1, 0.00012, 1e-12);

        yield* settingsService.updateSettings({ usagePriceOverrides: { "example-model": null } });
        const restored = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, original.buckets);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({ prefix: "usage-service-price-overrides-test", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "retains Codex reconciliation and partial coverage through persisted restart, append and repair",
    () =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const dir = NodePath.join(home, "codex", "sessions");
        const transcript = NodePath.join(dir, "rollout.jsonl");
        const usage = (input: number, output: number) => ({
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
        });
        const counted = (input: number, output: number, totalInput: number, totalOutput: number) =>
          encodeUnknownJsonString({
            type: "event_msg",
            timestamp: "2026-08-01T10:00:00Z",
            payload: {
              type: "token_count",
              info: {
                last_token_usage: usage(input, output),
                total_token_usage: usage(totalInput, totalOutput),
              },
            },
          });
        const tier = (service_tier: string) =>
          encodeUnknownJsonString({
            type: "event_msg",
            payload: { type: "thread_settings_applied", thread_settings: { service_tier } },
          });
        const bad = counted(10, 2, 130, 28);
        // Cross the reader's projection threshold so cumulative fields must survive selection.
        const stale = counted(20, 5, 100, 20).replace(
          '"payload":',
          '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"payload":',
        );
        let content = [
          encodeUnknownJsonString({ type: "turn_context", payload: { model: "gpt-6-astra" } }),
          counted(100, 20, 100, 20),
          stale,
          tier("priority"),
          bad,
        ].join("\n");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(dir, { recursive: true });
          await NodeFSP.writeFile(transcript, content);
        });
        yield* Effect.gen(function* () {
          const verify = (
            summary: UsageSummary,
            output: number,
            cost: number,
            malformed: number,
          ) => {
            assert.strictEqual(totalOutputTokens(summary), output);
            assert.strictEqual(
              summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
              cost,
            );
            const source = summary.sources.find(
              (source) => source.fingerprint.provider === "codex",
            );
            assert.strictEqual(source?.status, malformed === 0 ? "ok" : "partial");
            assert.strictEqual(source?.malformedRecords, malformed);
            if (malformed > 0) assert.match(source?.message ?? "", /1 malformed or inconsistent/);
            else assert.notMatch(source?.message ?? "", /malformed|inconsistent/);
          };
          const open = vi.spyOn(NodeFSP, "open");
          open.mockClear();
          yield* Effect.addFinalizer(() => Effect.sync(() => open.mockRestore()));
          const first = yield* UsageService.make;
          const cold = yield* first.readSummary(WINDOW);
          assert.isTrue(open.mock.calls.some(([path]) => path === transcript));
          verify(cold, 20, 20, 1);
          yield* first.awaitPersisted;
          const restarted = yield* UsageService.make;
          open.mockClear();
          verify(yield* first.readSummary(WINDOW), 20, 20, 1);
          verify(yield* restarted.readSummary(WINDOW), 20, 20, 1);
          assert.isFalse(open.mock.calls.some(([path]) => path === transcript));
          open.mockRestore();

          const append = "\n" + counted(10, 2, 140, 30) + "\n";
          content += append;
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, append));
          verify(yield* restarted.readSummary(WINDOW), 22, 24, 1);
          yield* restarted.awaitPersisted;
          const resumed = yield* UsageService.make;
          verify(yield* resumed.readSummary(WINDOW), 22, 24, 1);
          const next = tier("ultrafast") + "\n" + counted(10, 2, 150, 32) + "\n";
          content += next;
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, next));
          verify(yield* resumed.readSummary(WINDOW), 24, 36, 1);

          const repaired = content.replace(bad, counted(30, 8, 130, 28));
          assert.strictEqual(Buffer.byteLength(repaired), Buffer.byteLength(content));
          yield* Effect.promise(async () => {
            const stat = await NodeFSP.stat(transcript);
            await NodeFSP.writeFile(transcript, repaired);
            await NodeFSP.utimes(transcript, stat.atime, stat.mtimeMs / 1000 + 1);
          });
          verify(yield* resumed.readSummary(WINDOW), 32, 52, 0);
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-codex-reconciliation",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps large-record totals and costs exact through append, dedupe, restart and cleanup",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const large = claudeLine(1, 9900).replace(
          '"message":',
          '"padding":' + encodeUnknownJsonString("x".repeat(9 * 1024 * 1024)) + ',"message":',
        );
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, large));
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(first), 9900);
          assert.closeTo(
            first.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            0.4951,
            1e-12,
          );
          const warm = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(warm.buckets, first.buckets);
          yield* Effect.promise(() => NodeFSP.appendFile(transcript, large + claudeLine(2, 100)));
          const appended = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(appended), 10000);
          assert.strictEqual(
            appended.buckets.reduce((sum, bucket) => sum + bucket.totals.uncachedInputTokens, 0),
            20,
          );
          yield* service.awaitPersisted;
          const restarted = yield* UsageService.make;
          const restored = yield* restarted.readSummary(WINDOW);
          assert.deepStrictEqual(restored.buckets, appended.buckets);
          yield* restarted.awaitPersisted;
          yield* Effect.promise(() => NodeFSP.rm(transcript));
          const afterCleanup = yield* UsageService.make;
          assert.deepStrictEqual(
            (yield* afterCleanup.readSummary(WINDOW)).buckets,
            appended.buckets,
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layerService({
              prefix: "usage-service-large-record-test",
              home,
              settings,
              ratesDocument: {
                "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live.each([4, 5, 6, 7, 8, 9])(
    "upgrades a v%s cache: reparses live Codex usage, keeps deleted rollouts and retires the old file",
    (version) =>
      Effect.gen(function* () {
        const { home, settings } = yield* setup;
        const sessions = NodePath.join(home, "codex", "sessions");
        const rollout = (sessionId: string, outputTokens: number) =>
          [
            { type: "session_meta", payload: { id: sessionId } },
            { type: "turn_context", payload: { model: "gpt-6-astra" } },
            {
              type: "event_msg",
              payload: {
                type: "thread_settings_applied",
                thread_settings: { service_tier: "ultrafast" },
              },
            },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: { input_tokens: 0, output_tokens: outputTokens },
                  total_token_usage: { input_tokens: 100, output_tokens: outputTokens + 30 },
                },
              },
            },
          ]
            .map((line) => encodeUnknownJsonString(line))
            .join("\n") + "\n";
        const live = NodePath.join(sessions, "live.jsonl");
        const deleted = NodePath.join(sessions, "deleted.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          await NodeFSP.writeFile(live, rollout("live", 10));
          await NodeFSP.writeFile(deleted, rollout("deleted", 20));
        });

        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const legacyPath = NodePath.join(
            stateDir,
            version === 4 ? "usage-scan-cache.json" : `usage-scan-cache-v${version}.json`,
          );
          const first = yield* UsageService.make;
          yield* first.readSummary(WINDOW);
          yield* first.awaitPersisted;
          const { path: cachePath, document } = yield* onlySnapshot(stateDir);

          yield* Effect.promise(async () => {
            const livePath = await NodeFSP.realpath(live);
            for (const [path, file] of Object.entries(document.files)) {
              file.r = file.r.map((row) => [
                ...row.slice(0, 6),
                path === livePath ? 99 : row[6],
                ...row.slice(7, 10),
                version === 4 ? 0 : 1,
              ]);
              if (version === 4) delete file.cs.speed;
              if (version < 6) {
                delete file.cs.lastCumulativeUsage;
                delete file.cs.malformedRecords;
              }
              if (version === 8 && path === livePath) {
                file.r = [];
                file.mr = 1;
                file.cs.malformedRecords = 1;
              }
            }
            const text = encodeUnknownJsonString({ ...document, version });
            if (version === 9) {
              const current = decodeUnknownJsonString(
                await NodeFSP.readFile(cachePath, "utf8"),
              ) as StoredDocument;
              delete current.files[await NodeFSP.realpath(deleted)];
              await NodeFSP.writeFile(cachePath, encodeUnknownJsonString(current));
            } else {
              await NodeFSP.rm(cachePath);
            }
            await NodeFSP.writeFile(legacyPath, text);
            if (version === 6) {
              for (const [name, olderVersion] of [
                ["usage-scan-cache-v5.json", 5],
                ["usage-scan-cache.json", 4],
              ] as const) {
                await NodeFSP.writeFile(
                  NodePath.join(stateDir, name),
                  encodeUnknownJsonString({ ...document, version: olderVersion, files: {} }),
                );
              }
            }
            await NodeFSP.rm(deleted);
          });

          const upgraded = yield* UsageService.make;
          const summary = yield* upgraded.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 30);
          assert.strictEqual(
            summary.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0),
            60 + 20 * (version === 4 ? 1 : 2),
          );
          yield* upgraded.awaitPersisted;
          const fs = yield* FileSystem.FileSystem;
          assert.isFalse(yield* fs.exists(legacyPath));
          const restarted = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 30);
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-cache-upgrade-test",
              home,
              settings,
              ratesDocument: {
                "gpt-6-astra": {
                  input_cost_per_token: 0,
                  output_cost_per_token: 1,
                  input_cost_per_token_priority: 0,
                  output_cost_per_token_priority: 2,
                  input_cost_per_token_ultrafast: 0,
                  output_cost_per_token_ultrafast: 6,
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live.each(["read error", "invalid JSON"] as const)(
    "keeps a saved snapshot with a %s and reports it",
    (failure) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const seed = yield* UsageService.make;
          yield* seed.readSummary(WINDOW);
          yield* seed.awaitPersisted;
          const { path: saved, raw } = yield* onlySnapshot(stateDir);
          const unreadable = failure === "invalid JSON" ? "{" : raw;
          yield* fs.writeFileString(saved, unreadable);
          yield* fs.remove(transcript);

          const service = yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                failure === "read error" && file === saved
                  ? Effect.fail(
                      new PlatformError.PlatformError(
                        new PlatformError.BadArgument({
                          module: "FileSystem",
                          method: "readFileString",
                        }),
                      ),
                    )
                  : fs.readFileString(file, encoding),
            }),
          );
          const summary = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 0);
          assert.strictEqual(claudeSource(summary)?.status, "partial");
          assert.include(
            claudeSource(summary)?.message ?? "",
            failure === "read error"
              ? "Some saved usage could not be read."
              : "Some saved usage is damaged or from a newer version and is only partly counted.",
          );
          yield* service.awaitPersisted;
          assert.strictEqual(yield* fs.readFileString(saved), unreadable);

          yield* fs.writeFileString(saved, raw);
          const restarted = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 5);
        }).pipe(
          Effect.provide(
            layerService({ prefix: "usage-cache-unreadable-snapshot", home, settings }),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.live.each(["v9 source", "current source", "current file"] as const)(
    "counts deleted usage beside a malformed %s entry and keeps the damaged file",
    (damage) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const projects = NodePath.join(home, "claude", "projects");
        const actual = NodePath.join(home, "physical-projects");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(transcript, claudeLine(1, 5));
          await NodeFSP.rename(projects, actual);
          await NodeFSP.symlink(actual, projects, "junction");
        });
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const legacy = NodePath.join(stateDir, "usage-scan-cache-v9.json");
          const original = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* original.readSummary(WINDOW)), 5);
          yield* original.awaitPersisted;
          const { path: snapshot, document: cache } = yield* onlySnapshot(stateDir);
          if (damage === "current file") {
            (cache.files as Record<string, unknown>)["broken.jsonl"] = { unexpected: true };
          } else cache.sources["bad-root"] = { dir: false };
          let damaged = snapshot;
          if (damage === "v9 source") {
            cache.version = 9;
            damaged = legacy;
            yield* fs.remove(snapshot);
          }
          const bytes = encodeUnknownJsonString(cache);
          yield* fs.writeFileString(damaged, bytes);
          yield* fs.remove(projects);
          yield* fs.remove(actual, { recursive: true });

          const answersPartially = Effect.gen(function* () {
            const service = yield* UsageService.make;
            const summary = yield* service.readSummary(WINDOW);
            assert.strictEqual(totalOutputTokens(summary), 5);
            assert.strictEqual(claudeSource(summary)?.status, "partial");
            assert.include(claudeSource(summary)?.message ?? "", "only partly counted");
            yield* service.awaitPersisted;
          });
          yield* answersPartially;
          assert.isFalse(yield* fs.exists(legacy));
          const stored = yield* readStore(stateDir);
          const kept = stored.filter(({ raw }) => raw === bytes);
          assert.lengthOf(kept, 1);
          if (damage === "v9 source") {
            assert.match(kept[0]!.name, /^legacy-.+-usage-scan-cache-v9\.json$/);
          } else assert.strictEqual(kept[0]!.path, snapshot);
          const written = stored.filter(({ raw }) => raw !== bytes);
          assert.lengthOf(written, 1);
          const persisted = decodeUnknownJsonString(written[0]!.raw) as StoredDocument;
          assert.strictEqual(persisted.version, USAGE_SCAN_CACHE_VERSION);
          assert.isUndefined(persisted.sources["bad-root"]);
          assert.isUndefined(persisted.files["broken.jsonl"]);
          yield* answersPartially;
        }).pipe(Effect.provide(layerService({ prefix: "usage-cache-salvage", home, settings })));
      }).pipe(Effect.scoped),
  );

  it.live.each([
    { change: "append", sibling: false, expected: 9 },
    { change: "append", sibling: true, expected: 16 },
    { change: "smaller rewrite", sibling: false, expected: 5 },
  ] as const)(
    "keeps a peer's later $change over a paused writer (sibling: $sibling)",
    ({ change, sibling, expected }) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const writeTranscript = (contents: string) =>
          Effect.promise(async () => {
            await NodeFSP.writeFile(transcript, contents);
            await NodeFSP.utimes(transcript, CURSOR_NOW / 1000, CURSOR_NOW / 1000);
          });
        yield* writeTranscript(claudeLine(1, change === "append" ? 5 : 12));
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const only = NodePath.join(NodePath.dirname(transcript), "writer-only.jsonl");
          const peer = yield* UsageService.make;
          yield* peer.readSummary(WINDOW);
          yield* peer.awaitPersisted;
          // Two more copies make the writer's save a full one, which saves the row it loaded again.
          const { raw: loaded } = yield* onlySnapshot(stateDir);
          yield* seedSnapshot(stateDir, loaded);
          yield* seedSnapshot(stateDir, loaded);
          if (sibling) yield* fs.writeFileString(only, claudeLine(3, 7));

          const publishing = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(resume, undefined));
          let published = 0;
          const writer = yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              rename: (from, to) =>
                Effect.suspend(() =>
                  isSnapshotPublish(stateDir, from, to) && published++ === 0
                    ? Deferred.succeed(publishing, undefined).pipe(
                        Effect.andThen(Deferred.await(resume)),
                        Effect.andThen(fs.rename(from, to)),
                      )
                    : fs.rename(from, to),
                ),
            }),
          );
          yield* writer.readSummary(WINDOW);
          yield* Deferred.await(publishing);

          if (sibling) yield* fs.remove(only);
          yield* writeTranscript(
            change === "append" ? claudeLine(1, 5) + claudeLine(2, 4) : claudeLine(1, 5),
          );
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual(
            totalOutputTokens(yield* peer.readSummary(WINDOW)),
            change === "append" ? 9 : 5,
          );
          yield* peer.awaitPersisted;
          const { path: correction } = yield* onlySnapshot(stateDir);

          yield* Deferred.succeed(resume, undefined);
          yield* writer.awaitPersisted;
          assert.isTrue(yield* fs.exists(correction));
          yield* fs.remove(transcript);
          const restarted = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), expected);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-cache-paused-writer", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["saves", "cannot save"] as const)(
    "after a transient read failure, a shutdown that %s its dirty rows",
    (outcome) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const logs = captureLogs();
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const storeDir = storeDirOf(stateDir);
          const peer = yield* UsageService.make;
          yield* peer.readSummary(WINDOW);
          yield* peer.awaitPersisted;

          let deny = true;
          let published = 0;
          const blocked = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            const service = yield* UsageService.make.pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                readFileString: (file, encoding) =>
                  deny && NodePath.dirname(file) === storeDir
                    ? Effect.fail(PERMISSION_DENIED("readFileString"))
                    : fs.readFileString(file, encoding),
                rename: (from, to) =>
                  Effect.suspend(() => {
                    if (!isSnapshotPublish(stateDir, from, to)) return fs.rename(from, to);
                    published += 1;
                    if (published === 2) {
                      return Deferred.succeed(blocked, undefined).pipe(
                        Effect.andThen(Effect.never),
                      );
                    }
                    return published === 3 && outcome === "cannot save"
                      ? Effect.fail(PERMISSION_DENIED("rename"))
                      : fs.rename(from, to);
                  }),
              }),
            );
            const first = yield* service.readSummary(WINDOW);
            assert.strictEqual(claudeSource(first)?.status, "partial");
            yield* service.awaitPersisted;
            assert.strictEqual(published, 1);

            deny = false;
            yield* fs.writeFileString(transcript, claudeLine(1, 5) + claudeLine(2, 7));
            yield* TestClock.adjust("5 seconds");
            assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
            yield* Deferred.await(blocked);
          }).pipe(Effect.scoped);

          assert.strictEqual(published, 3);
          assert.deepStrictEqual(
            logs.of("Error", "Could not finish saving transcript usage at shutdown"),
            outcome === "saves" ? [] : [{ path: storeDir, unsavedRows: 1 }],
          );
          yield* fs.remove(transcript);
          const restarted = yield* UsageService.make;
          assert.strictEqual(
            totalOutputTokens(yield* restarted.readSummary(WINDOW)),
            outcome === "saves" ? 12 : 5,
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerService({ prefix: "usage-cache-shutdown-save", home, settings }),
              logs.layer,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps a damaged older cache as a reported gap until it is removed", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const logs = captureLogs();
      const damagedText = "Saved transcript usage is damaged or from a newer version";
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const archive = NodePath.join(stateDir, "usage-scan-cache-v10.json");
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFileString(archive, "{");
        const service = yield* UsageService.make;
        for (const _ of [1, 2]) {
          const summary = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 5);
          assert.strictEqual(claudeSource(summary)?.status, "partial");
          yield* service.awaitPersisted;
          yield* TestClock.adjust("1 minute");
        }
        assert.isFalse(yield* fs.exists(archive));
        const claimed = (yield* readStore(stateDir)).filter(({ name }) =>
          name.startsWith("legacy-"),
        );
        assert.lengthOf(claimed, 1);
        assert.match(claimed[0]!.name, /-usage-scan-cache-v10\.json$/);
        assert.strictEqual(claimed[0]!.raw, "{");
        assert.lengthOf(logs.of("Error", damagedText), 1);

        yield* fs.remove(claimed[0]!.path);
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        assert.deepStrictEqual(
          logs.of(
            "Warn",
            "Damaged saved transcript usage was removed; the part that could not be read is not counted",
          ),
          [{ path: claimed[0]!.path }],
        );
        const cleared = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(cleared), 5);
        assert.strictEqual(claudeSource(cleared)?.status, "ok");
        assert.deepStrictEqual(logs.of("Info", "Recovered saved transcript usage"), []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerService({ prefix: "usage-cache-damaged-archive", home, settings }),
            logs.layer,
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("claims a legacy cache once across concurrent startups and keeps its rows", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const archive = NodePath.join(stateDir, "usage-scan-cache-v9.json");
        const seed = yield* UsageService.make;
        yield* seed.readSummary(WINDOW);
        yield* seed.awaitPersisted;
        const { path: snapshot, document } = yield* onlySnapshot(stateDir);
        yield* fs.writeFileString(archive, encodeUnknownJsonString({ ...document, version: 9 }));
        yield* fs.remove(snapshot);
        yield* fs.remove(transcript);

        const claiming = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const first = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              from === archive
                ? Deferred.succeed(claiming, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fs.rename(from, to)),
                  )
                : fs.rename(from, to),
          }),
        );
        yield* Deferred.await(claiming);
        const firstRead = yield* first.readSummary(WINDOW).pipe(Effect.forkChild);
        const second = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* second.readSummary(WINDOW)), 5);
        yield* second.awaitPersisted;
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(firstRead)), 5);
        yield* first.awaitPersisted;
        assert.isFalse(yield* fs.exists(archive));
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 5);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-cache-concurrent-start", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live("keeps the larger legacy row when two older caches observed it at once", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const archive = NodePath.join(stateDir, "usage-scan-cache-v9.json");
        const seed = yield* UsageService.make;
        yield* seed.readSummary(WINDOW);
        yield* seed.awaitPersisted;
        const { path: snapshot, document: saved } = yield* onlySnapshot(stateDir);
        yield* fs.remove(snapshot);
        yield* fs.writeFileString(
          NodePath.join(stateDir, "usage-scan-cache-v10.json"),
          encodeUnknownJsonString({ ...saved, version: 10 }),
        );
        const copied = saved.files[transcript]!;
        copied.s *= 2;
        copied.r[0]![6] = 12;
        yield* fs.writeFileString(archive, encodeUnknownJsonString({ ...saved, version: 9 }));
        yield* fs.remove(transcript);

        const upgraded = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* upgraded.readSummary(WINDOW)), 12);
        yield* upgraded.awaitPersisted;
        assert.isFalse(yield* fs.exists(archive));
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 12);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-cache-larger-legacy", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live.each(["listing", "claim"] as const)(
    "reports a denied %s once per input and retries it later",
    (operation) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const logs = captureLogs();
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const storeDir = storeDirOf(stateDir);
          const archives = ["usage-scan-cache-v9.json", "usage-scan-cache-v10.json"].map((name) =>
            NodePath.join(stateDir, name),
          );
          const seed = yield* UsageService.make;
          yield* seed.readSummary(WINDOW);
          yield* seed.awaitPersisted;
          const { path: snapshot, document } = yield* onlySnapshot(stateDir);
          yield* fs.writeFileString(
            archives[0]!,
            encodeUnknownJsonString({ ...document, version: 9 }),
          );
          yield* fs.writeFileString(
            archives[1]!,
            encodeUnknownJsonString({ ...document, version: 10, files: {} }),
          );
          yield* fs.remove(snapshot);
          yield* fs.remove(transcript);

          let deny = true;
          let attempts = 0;
          const refuse = (method: string) =>
            Effect.sync(() => attempts++).pipe(
              Effect.andThen(Effect.fail(PERMISSION_DENIED(method))),
            );
          const service = yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readDirectory: (directory, options) =>
                deny &&
                operation === "listing" &&
                (directory === stateDir || directory === storeDir)
                  ? refuse("readDirectory")
                  : fs.readDirectory(directory, options),
              rename: (from, to) =>
                deny && operation === "claim" && archives.includes(from)
                  ? refuse("rename")
                  : fs.rename(from, to),
            }),
          );
          const summary = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), 0);
          assert.strictEqual(claudeSource(summary)?.status, "partial");
          assert.include(
            claudeSource(summary)?.message ?? "",
            operation === "listing"
              ? "Saved usage could not be listed."
              : "Older saved usage could not be moved into the current cache.",
          );
          const failures = () =>
            logs
              .of(
                "Error",
                operation === "listing"
                  ? "Could not list saved transcript usage"
                  : "Could not move older saved transcript usage into the current cache",
              )
              .map((fields) => (fields as { path: string }).path);
          assert.sameMembers(failures(), operation === "listing" ? [stateDir, storeDir] : archives);
          yield* service.awaitPersisted;
          for (const archive of archives) assert.isTrue(yield* fs.exists(archive));
          const initialAttempts = attempts;
          for (let request = 0; request < 5; request++) {
            yield* service.readSummary(WINDOW);
            yield* service.awaitPersisted;
          }
          assert.strictEqual(attempts, initialAttempts);
          assert.lengthOf(failures(), 2);

          const restarted = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 5);
          yield* restarted.awaitPersisted;
          deny = false;
          yield* fs.writeFileString(
            NodePath.join(NodePath.dirname(transcript), "later.jsonl"),
            claudeLine(2, 7),
          );
          yield* TestClock.adjust("1 minute");
          const recovered = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(recovered), 12);
          assert.strictEqual(claudeSource(recovered)?.status, "ok");
          if (operation === "listing") {
            assert.sameDeepMembers(logs.of("Info", "Recovered saved transcript usage"), [
              { path: stateDir },
              { path: storeDir },
            ]);
          }
          yield* service.awaitPersisted;
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerService({ prefix: "usage-cache-denied-input", home, settings }),
              logs.layer,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("merges two stale process views on persistence without dropping rows", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = yield* UsageService.make;
        const second = yield* UsageService.make;
        yield* first.readSummary(WINDOW);
        yield* first.awaitPersisted;
        yield* second.readSummary(WINDOW);
        yield* second.awaitPersisted;
        const later = NodePath.join(NodePath.dirname(transcript), "later.jsonl");
        yield* fs.writeFileString(transcript, claudeLine(1, 5));
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(totalOutputTokens(yield* first.readSummary(WINDOW)), 5);
        yield* first.awaitPersisted;
        yield* fs.remove(transcript);
        yield* fs.writeFileString(later, claudeLine(2, 7));
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(totalOutputTokens(yield* second.readSummary(WINDOW)), 7);
        yield* second.awaitPersisted;
        yield* fs.remove(later);
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 12);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-cache-stale-writers", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["deleted usage", "live reparse"] as const)(
    "claims a v10 cache an older build writes after the upgrade, with %s",
    (scenario) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* writeTranscriptAtCursorNow(transcript, 5);
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const previous = NodePath.join(stateDir, "usage-scan-cache-v10.json");
          const archive = NodePath.join(stateDir, "usage-scan-cache-v9.json");
          const seed = yield* UsageService.make;
          yield* seed.readSummary(WINDOW);
          yield* seed.awaitPersisted;
          const { path: snapshot, document: saved } = yield* onlySnapshot(stateDir);
          const entry = saved.files[transcript]!;
          yield* fs.remove(snapshot);
          yield* fs.writeFileString(
            previous,
            encodeUnknownJsonString({ ...saved, version: 10, files: {} }),
          );
          yield* fs.writeFileString(archive, encodeUnknownJsonString({ ...saved, version: 9 }));
          if (scenario === "deleted usage") yield* fs.remove(transcript);
          else yield* writeTranscriptAtCursorNow(transcript, 7);

          const updated = yield* UsageService.make;
          const loaded = yield* updated.readSummary(
            scenario === "live reparse" ? NARROW_WINDOW : WINDOW,
          );
          if (scenario === "deleted usage") assert.strictEqual(totalOutputTokens(loaded), 5);
          yield* updated.awaitPersisted;
          assert.isFalse(yield* fs.exists(archive));
          assert.isFalse(yield* fs.exists(previous));
          const sibling = NodePath.join(NodePath.dirname(transcript), "old-build.jsonl");
          const { nr: _reparse, ...legacyEntry } = entry;
          const records = entry.r.map((record) => [...record]);
          records[0]![6] = scenario === "live reparse" ? 12 : 7;
          records[0]![8] = "other-event";
          yield* fs.writeFileString(
            previous,
            encodeUnknownJsonString({
              ...saved,
              version: 10,
              files: {
                ...(scenario === "live reparse" ? { [transcript]: legacyEntry } : {}),
                [sibling]: { ...legacyEntry, r: records },
              },
            }),
          );
          const restarted = yield* UsageService.make;
          assert.strictEqual(
            totalOutputTokens(yield* restarted.readSummary(WINDOW)),
            scenario === "live reparse" ? 19 : 12,
          );
          yield* restarted.awaitPersisted;
          assert.isFalse(yield* fs.exists(previous));
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-cache-rolling-update", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("persists a verified smaller rewrite when its disk base is unchanged", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* writeTranscriptAtCursorNow(transcript, 12);
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        yield* service.awaitPersisted;
        yield* writeTranscriptAtCursorNow(transcript, 5);
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 5);
        yield* service.awaitPersisted;
        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 5);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-three-way", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["peer", "migration", "late archive", "unrelated peer write"] as const)(
    "keeps a verified correction ahead of a stale %s",
    (scenario) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* writeTranscriptAtCursorNow(transcript, 12);
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const archive = NodePath.join(stateDir, "usage-scan-cache-v10.json");
          const seed = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* seed.readSummary(WINDOW)), 12);
          yield* seed.awaitPersisted;
          const { path: snapshot, document: original } = yield* onlySnapshot(stateDir);
          const stale = encodeUnknownJsonString({ ...original, version: 10 });
          if (scenario === "migration") {
            yield* fs.writeFileString(archive, stale);
            yield* fs.remove(snapshot);
          }
          const writer = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* writer.readSummary(WINDOW)), 12);
          yield* writer.awaitPersisted;
          const peer = yield* UsageService.make;
          const sibling = NodePath.join(NodePath.dirname(transcript), "new.jsonl");
          if (scenario === "unrelated peer write") {
            yield* fs.writeFileString(sibling, claudeLine(2, 7));
            assert.strictEqual(totalOutputTokens(yield* peer.readSummary(WINDOW)), 19);
            yield* peer.awaitPersisted;
            yield* fs.remove(sibling);
          }
          if (scenario === "peer") {
            assert.strictEqual(totalOutputTokens(yield* peer.readSummary(WINDOW)), 12);
            yield* peer.awaitPersisted;
          }
          yield* writeTranscriptAtCursorNow(transcript, 5);
          assert.strictEqual(totalOutputTokens(yield* writer.readSummary(WINDOW)), 5);
          yield* writer.awaitPersisted;
          yield* fs.remove(transcript);
          if (scenario === "peer") {
            yield* fs.writeFileString(sibling, claudeLine(2, 7));
            yield* TestClock.adjust("5 seconds");
            yield* peer.readSummary(WINDOW);
            yield* peer.awaitPersisted;
            yield* fs.remove(sibling);
          }
          if (scenario === "late archive") yield* fs.writeFileString(archive, stale);
          const restarted = yield* UsageService.make;
          assert.strictEqual(
            totalOutputTokens(yield* restarted.readSummary(WINDOW)),
            scenario === "peer" || scenario === "unrelated peer write" ? 12 : 5,
          );
          yield* restarted.awaitPersisted;
        }).pipe(Effect.provide(layerService({ prefix: "usage-cache-correction", home, settings })));
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("prunes expired rows before every write, the shutdown write included", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* writeTranscriptAtCursorNow(transcript, 5);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const archive = NodePath.join(stateDir, "usage-scan-cache-v10.json");
        const shutDownWithoutScan = Effect.scoped(
          Effect.flatMap(UsageService.make, (service) => service.awaitPersisted),
        );
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* fs.remove(transcript);
        yield* TestClock.adjust("93 days");
        // No scan saw the deletion, so the write keeps the row for the next scan to find it gone.
        yield* shutDownWithoutScan;
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        const { document: missing } = yield* onlySnapshot(stateDir);
        yield* TestClock.adjust("93 days");
        assert.strictEqual(yield* outputTokensAfterRestart, 0);
        assert.isEmpty(yield* storedFileKeys(stateDir));
        yield* fs.writeFileString(archive, encodeUnknownJsonString({ ...missing, version: 10 }));

        yield* shutDownWithoutScan;
        assert.isFalse(yield* fs.exists(archive));
        assert.isEmpty(yield* storedFileKeys(stateDir));
        assert.isFalse((yield* readStore(stateDir)).some(({ name }) => name.startsWith("legacy-")));
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-retention", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("counts a transcript deleted at age 91 days until 92 days after the deletion", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const deletedAt = CURSOR_NOW + 91 * DAY_MS;
      yield* TestClock.setTime(deletedAt);
      yield* writeTranscriptAtCursorNow(transcript, 5);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* fs.remove(transcript);
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* TestClock.adjust("2 days");
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* TestClock.setTime(deletedAt + 92 * DAY_MS);
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* TestClock.adjust("1 millis");
        assert.strictEqual(yield* outputTokensAfterRestart, 0);
        assert.isEmpty(yield* storedFileKeys(stateDir));
      }).pipe(Effect.provide(layerService({ prefix: "usage-deleted-retention", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each([
    "came back",
    "came back beside an unreadable folder",
    "could not be listed",
  ] as const)("starts the retention of a transcript that %s at its deletion", (scenario) =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const writeTranscript = writeTranscriptAtCursorNow(transcript, 5);
      yield* writeTranscript;
      const projectDir = yield* Effect.promise(() =>
        NodeFSP.realpath(NodePath.dirname(transcript)),
      );
      const siblingDir = NodePath.join(NodePath.dirname(projectDir), "sibling");
      yield* Effect.promise(() => NodeFSP.mkdir(siblingDir));
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      let deniedDir: string | undefined;
      using _readdir = vi.spyOn(NodeFSP, "readdir").mockImplementation(async (...args) => {
        if (args[0] === deniedDir) throw new Error("permission denied");
        return actual.readdir(...args);
      });
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        if (scenario === "could not be listed") deniedDir = projectDir;
        else yield* fs.remove(transcript);
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* TestClock.adjust("50 days");
        if (scenario !== "could not be listed") {
          if (scenario === "came back beside an unreadable folder") deniedDir = siblingDir;
          yield* writeTranscript;
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
        }
        yield* fs.remove(transcript);
        deniedDir = undefined;
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* TestClock.adjust("43 days");
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
      }).pipe(Effect.provide(layerService({ prefix: "usage-returned-retention", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    "keeps a restored transcript's usage until 92 days after it goes again in two writers",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const writeTranscript = writeTranscriptAtCursorNow(transcript, 5);
        yield* writeTranscript;
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const writers = [yield* UsageService.make, yield* UsageService.make];
          // Each save merges the other writer's latest snapshot, rows from before a restore included.
          const scanInTurn = Effect.forEach(
            writers,
            (writer) =>
              Effect.gen(function* () {
                assert.strictEqual(totalOutputTokens(yield* writer.readSummary(WINDOW)), 5);
                yield* writer.awaitPersisted;
              }),
            { discard: true },
          );
          yield* scanInTurn;
          yield* fs.remove(transcript);
          yield* TestClock.adjust("1 day");
          yield* scanInTurn;
          yield* TestClock.adjust("10 days");
          yield* writeTranscript;
          yield* scanInTurn;
          yield* TestClock.adjust("69 days");
          const deletedAgainAt = CURSOR_NOW + 80 * DAY_MS;
          yield* fs.remove(transcript);
          yield* scanInTurn;
          yield* TestClock.setTime(deletedAgainAt + 92 * DAY_MS);
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* TestClock.adjust("1 millis");
          assert.strictEqual(yield* outputTokensAfterRestart, 0);
          assert.isEmpty(yield* storedFileKeys(stateDir));
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-two-writer-retention", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    "keeps the missing time of a transcript found back and gone again in one millisecond",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const writeTranscript = writeTranscriptAtCursorNow(transcript, 5);
        yield* writeTranscript;
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* fs.remove(transcript);
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* writeTranscript;
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* fs.remove(transcript);
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          // Peers' copies of the row make the next load merge the row with itself and save it
          // in full.
          const { raw } = yield* onlySnapshot(stateDir);
          yield* seedSnapshot(stateDir, raw);
          yield* seedSnapshot(stateDir, raw);
          yield* Effect.scoped(
            Effect.flatMap(UsageService.make, (service) => service.awaitPersisted),
          );
          const { document } = yield* onlySnapshot(stateDir);
          assert.strictEqual(document.files[transcript]?.ms, CURSOR_NOW);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-same-millisecond-return", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["finishes", "does not finish"] as const)(
    "counts a transcript an unreadable folder hid until 92 days after a check found it gone, when the first check %s",
    (scenario) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* writeTranscriptAtCursorNow(transcript, 5);
        const projectDir = yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.dirname(transcript)),
        );
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        let denied = false;
        using _readdir = vi.spyOn(NodeFSP, "readdir").mockImplementation(async (...args) => {
          if (denied && args[0] === projectDir) throw new Error("permission denied");
          return actual.readdir(...args);
        });
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          denied = true;
          yield* fs.remove(transcript);
          yield* TestClock.adjust("93 days");
          if (scenario === "does not finish") {
            const began = yield* Deferred.make<void>();
            let hangs = true;
            let checks = 0;
            const service = yield* UsageService.make.pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                exists: (path) =>
                  path !== transcript
                    ? fs.exists(path)
                    : Effect.suspend(() => {
                        checks += 1;
                        return hangs
                          ? Deferred.succeed(began, undefined).pipe(Effect.andThen(Effect.never))
                          : fs.exists(path);
                      }),
              }),
            );
            const answer = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
            yield* Deferred.await(began);
            yield* TestClock.adjust("5 seconds");
            assert.strictEqual(totalOutputTokens(yield* Fiber.join(answer)), 0);
            yield* service.awaitPersisted;
            assert.deepStrictEqual(yield* storedFileKeys(stateDir), [transcript]);
            hangs = false;
            // The backoff runs on time awake, so a wall clock stepped back does not stretch it.
            yield* TestClock.setTime((yield* Clock.currentTimeMillis) - 6 * HOUR_MS);
            yield* TestClock.adjust("59 minutes");
            assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 0);
            assert.strictEqual(checks, 1);
            yield* TestClock.adjust("1 minute");
            assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 5);
            assert.strictEqual(checks, 2);
            yield* service.awaitPersisted;
          }
          const checkedAt = yield* Clock.currentTimeMillis;
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* TestClock.setTime(checkedAt + 92 * DAY_MS);
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* TestClock.adjust("1 millis");
          assert.strictEqual(yield* outputTokensAfterRestart, 0);
          assert.isEmpty(yield* storedFileKeys(stateDir));
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-unchecked-retention", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    "answers at the check time limit when more expired files hang than are checked at once",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const projectDir = yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.dirname(transcript)),
        );
        const transcripts = Array.from({ length: STAT_CONCURRENCY + 1 }, (_, index) =>
          NodePath.join(projectDir, `session-${index}.jsonl`),
        );
        yield* Effect.promise(() =>
          Promise.all(
            transcripts.map(async (file, index) => {
              await NodeFSP.writeFile(file, claudeLine(index, 5));
              await NodeFSP.utimes(file, CURSOR_NOW / 1000, CURSOR_NOW / 1000);
            }),
          ),
        );
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        let denied = false;
        using _readdir = vi.spyOn(NodeFSP, "readdir").mockImplementation(async (...args) => {
          if (denied && args[0] === projectDir) throw new Error("permission denied");
          return actual.readdir(...args);
        });
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          assert.strictEqual(yield* outputTokensAfterRestart, 5 * transcripts.length);
          denied = true;
          yield* TestClock.adjust("93 days");
          const allBegan = yield* Deferred.make<void>();
          const checked: string[] = [];
          let hangs = true;
          const service = yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              exists: (path) =>
                transcripts.includes(path)
                  ? Effect.suspend(() => {
                      checked.push(path);
                      if (!hangs) return fs.exists(path);
                      return (
                        checked.length === STAT_CONCURRENCY
                          ? Deferred.succeed(allBegan, undefined)
                          : Effect.void
                      ).pipe(Effect.andThen(Effect.never));
                    })
                  : fs.exists(path),
            }),
          );
          const answer = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* Deferred.await(allBegan);
          yield* TestClock.adjust("5 seconds");
          assert.strictEqual(totalOutputTokens(yield* Fiber.join(answer)), 0);
          assert.lengthOf(checked, STAT_CONCURRENCY);
          const unreached = transcripts.filter((file) => !checked.includes(file));
          hangs = false;
          yield* TestClock.adjust("1 minute");
          assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 0);
          assert.deepStrictEqual(checked.slice(STAT_CONCURRENCY), unreached);
        }).pipe(Effect.provide(layerService({ prefix: "usage-hung-checks", home, settings })));
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["missing", "present"] as const)(
    "counts a saved %s time ahead of the clock from now",
    (field) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* writeTranscriptAtCursorNow(transcript, 5);
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          const { path, document: original } = yield* onlySnapshot(stateDir);
          yield* fs.remove(transcript);
          yield* TestClock.adjust("10 days");
          const deletedAt = CURSOR_NOW + 10 * DAY_MS;
          const ahead = {
            ...original.files[transcript],
            [field === "missing" ? "ms" : "ps"]: 1e15,
          };
          yield* fs.writeFileString(
            path,
            encodeUnknownJsonString({
              ...original,
              files: { ...original.files, [transcript]: ahead },
            }),
          );
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          // A peer's row for the file merges with the corrected one.
          yield* seedSnapshot(stateDir, encodeUnknownJsonString(original));
          yield* TestClock.setTime(deletedAt + 92 * DAY_MS);
          assert.strictEqual(yield* outputTokensAfterRestart, 5);
          yield* TestClock.adjust("1 millis");
          assert.strictEqual(yield* outputTokensAfterRestart, 0);
          assert.isEmpty(yield* storedFileKeys(stateDir));
        }).pipe(Effect.provide(layerService({ prefix: "usage-future-presence", home, settings })));
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("drops the saved row of a transcript still on disk past its last write's retention", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* writeTranscriptAtCursorNow(transcript, 5);
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        yield* TestClock.adjust("93 days");
        assert.strictEqual(yield* outputTokensAfterRestart, 5);
        assert.isEmpty(yield* storedFileKeys(stateDir));
      }).pipe(Effect.provide(layerService({ prefix: "usage-live-retention", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("answers a warm scan while a sync is blocked on disk", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const publishing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        let published = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              Effect.suspend(() =>
                isSnapshotPublish(stateDir, from, to) && published++ === 0
                  ? Deferred.succeed(publishing, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(fs.rename(from, to)),
                    )
                  : fs.rename(from, to),
              ),
          }),
        );
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 5);
        yield* Deferred.await(publishing);
        yield* fs.writeFileString(transcript, claudeLine(1, 12));
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        yield* Deferred.succeed(release, undefined);
        yield* service.awaitPersisted;
        yield* fs.remove(transcript);
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 12);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-warm-scan", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("answers with a load gap while a due retry of saved usage hangs on disk", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const logs = captureLogs();
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const storeDir = storeDirOf(stateDir);
        const hung = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let store: "denied" | "hung" | "ok" = "denied";
        let listsWhileHung = 0;
        let listsOnceOk = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) =>
              Effect.suspend(() => {
                if (directory !== storeDir) return fs.readDirectory(directory, options);
                if (store === "ok") {
                  listsOnceOk++;
                  return fs.readDirectory(directory, options);
                }
                if (store === "denied") return Effect.fail(PERMISSION_DENIED("readDirectory"));
                return listsWhileHung++ === 0
                  ? Deferred.succeed(hung, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(fs.readDirectory(directory, options)),
                    )
                  : fs.readDirectory(directory, options);
              }),
          }),
        );
        const denied = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(denied), 5);
        assert.strictEqual(claudeSource(denied)?.message, "Saved usage could not be listed.");
        yield* service.awaitPersisted;

        store = "hung";
        yield* TestClock.adjust("1 minute");
        const waiting = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
        yield* Deferred.await(hung);
        yield* TestClock.adjust("20 seconds");
        const late = yield* Fiber.join(waiting);
        yield* TestClock.adjust("5 seconds");
        const skipped = yield* service.readSummary(WINDOW);
        for (const summary of [late, skipped]) {
          assert.deepStrictEqual(
            {
              tokens: totalOutputTokens(summary),
              status: claudeSource(summary)?.status,
              message: claudeSource(summary)?.message,
            },
            {
              tokens: 5,
              status: "partial",
              message: "Saved usage could not be listed. Saved usage has not finished loading.",
            },
          );
        }
        assert.strictEqual(listsWhileHung, 1);
        assert.deepStrictEqual(
          logs
            .of("Error", "Saved transcript usage did not load in time")
            .map((fields) => (fields as { path: string }).path),
          [storeDir],
        );

        store = "ok";
        yield* Deferred.succeed(release, undefined);
        yield* service.awaitPersisted;
        // Both scans' persists waited behind the hung load; the one that ran covered both.
        assert.strictEqual(listsOnceOk, 1);
        yield* TestClock.adjust("5 seconds");
        const loaded = yield* service.readSummary(WINDOW);
        assert.strictEqual(claudeSource(loaded)?.status, "ok");
        assert.isNull(claudeSource(loaded)?.message);
        const pathsLogged = (message: string) =>
          logs.of("Info", message).map((fields) => (fields as { path: string }).path);
        assert.deepStrictEqual(pathsLogged("Recovered saved transcript usage"), [storeDir]);
        assert.deepStrictEqual(pathsLogged("Saved transcript usage finished loading"), [storeDir]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerService({ prefix: "usage-cache-hung-load", home, settings }),
            logs.layer,
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps a re-parsed row ahead of a peer's older one after the clock steps back", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const peer = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* peer.readSummary(WINDOW)), 5);
        yield* peer.awaitPersisted;

        yield* TestClock.setTime(CURSOR_NOW - HOUR_MS);
        yield* fs.writeFileString(transcript, claudeLine(1, 5) + claudeLine(2, 7));
        const stepped = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* stepped.readSummary(WINDOW)), 12);
        yield* stepped.awaitPersisted;

        yield* fs.remove(transcript);
        yield* peer.readSummary(WINDOW);
        yield* peer.awaitPersisted;
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), 12);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-clock-step", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("reads each saved snapshot name at most once", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const reads = new Map<string, number>();
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, encoding) => {
              if (NodePath.dirname(file) === storeDirOf(stateDir)) {
                reads.set(file, (reads.get(file) ?? 0) + 1);
              }
              return fs.readFileString(file, encoding);
            },
          }),
        );
        yield* fs.writeFileString(transcript, claudeLine(1, 5));
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        yield* fs.writeFileString(transcript, claudeLine(1, 12));
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        assert.strictEqual(reads.size, 0);
        const own = new Set((yield* readStore(stateDir)).map(({ path }) => path));

        const peer = yield* UsageService.make;
        const peerTranscript = NodePath.join(NodePath.dirname(transcript), "peer.jsonl");
        yield* fs.writeFileString(peerTranscript, claudeLine(2, 7));
        yield* peer.readSummary(WINDOW);
        yield* peer.awaitPersisted;
        const peerSnapshots = (yield* readStore(stateDir)).filter(({ path }) => !own.has(path));
        assert.lengthOf(peerSnapshots, 1);
        const peerSnapshot = peerSnapshots[0]!.path;
        yield* fs.remove(peerTranscript);
        yield* fs.writeFileString(transcript, claudeLine(1, 30));
        for (const _ of [1, 2, 3]) {
          yield* service.readSummary(WINDOW);
          yield* service.awaitPersisted;
        }
        assert.deepStrictEqual([...reads], [[peerSnapshot, 1]]);
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 37);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-read-once", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("saves only the row of the transcript that grew", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const transcripts = Array.from({ length: 20 }, (_, index) =>
        NodePath.join(NodePath.dirname(transcript), `session-${index}.jsonl`),
      );
      yield* Effect.forEach(
        transcripts,
        (file, index) => Effect.promise(() => NodeFSP.writeFile(file, claudeLine(index + 1, 5))),
        { discard: true },
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const service = yield* UsageService.make;
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        const full = yield* onlySnapshot(stateDir);
        assert.sameMembers(Object.keys(full.document.files), transcripts);

        yield* Effect.promise(() => NodeFSP.appendFile(transcripts[1]!, claudeLine(100, 7)));
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 107);
        yield* service.awaitPersisted;
        const saved = yield* newestSnapshot(stateDir);
        assert.notStrictEqual(saved.path, full.path);
        assert.deepStrictEqual(Object.keys(saved.document.files), [transcripts[1]]);
        assert.isBelow(Buffer.byteLength(saved.raw) * 4, Buffer.byteLength(full.raw));
        yield* Effect.forEach(transcripts, (file) => fs.remove(file), { discard: true });
        assert.strictEqual(yield* outputTokensAfterRestart, 107);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-delta", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps two services that share a state directory to the rows each one saw change", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const dir = NodePath.dirname(transcript);
      const transcripts = Array.from({ length: 40 }, (_, index) =>
        NodePath.join(dir, `session-${index}.jsonl`),
      );
      yield* Effect.forEach(
        transcripts,
        (file, index) => Effect.promise(() => NodeFSP.writeFile(file, claudeLine(index + 1, 5))),
        { discard: true },
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const saves: { readonly rows: number; readonly bytes: number }[] = [];
        const countingSaves: FileSystem.FileSystem = {
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (isSnapshotPublish(stateDir, from, to)) {
                const raw = yield* fs.readFileString(from);
                const { files } = decodeUnknownJsonString(raw) as StoredDocument;
                saves.push({ rows: Object.keys(files).length, bytes: Buffer.byteLength(raw) });
              }
              return yield* fs.rename(from, to);
            }),
        };
        const services = [
          yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, countingSaves),
          ),
          yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, countingSaves),
          ),
        ];
        const scanBoth = Effect.forEach(
          services,
          (service) =>
            Effect.gen(function* () {
              yield* TestClock.adjust("5 seconds");
              yield* service.readSummary(WINDOW);
              yield* service.awaitPersisted;
            }),
          { discard: true },
        );
        yield* scanBoth;
        assert.deepStrictEqual(
          saves.map(({ rows }) => rows),
          [transcripts.length],
        );
        const rounds = 4;
        for (let round = 0; round < rounds; round += 1) {
          yield* Effect.promise(() =>
            NodeFSP.appendFile(transcripts[round]!, claudeLine(100 + round, 7)),
          );
          yield* scanBoth;
        }
        const later = saves.slice(1);
        assert.deepStrictEqual(
          later.map(({ rows }) => rows),
          Array.from({ length: 2 * rounds }, () => 1),
        );
        assert.isBelow(
          later.reduce((sum, { bytes }) => sum + bytes, 0),
          saves[0]!.bytes,
        );
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-shared-delta", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("saves only changed rows after a peer's full save retires this writer's snapshots", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const transcripts = Array.from({ length: 20 }, (_, index) =>
        NodePath.join(NodePath.dirname(transcript), `session-${index}.jsonl`),
      );
      yield* Effect.forEach(
        transcripts,
        (file, index) => Effect.promise(() => NodeFSP.writeFile(file, claudeLine(index + 1, 5))),
        { discard: true },
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const grow = (index: number) =>
          Effect.promise(() => NodeFSP.appendFile(transcripts[index]!, claudeLine(100 + index, 7)));
        const writer = yield* UsageService.make;
        yield* writer.readSummary(WINDOW);
        yield* writer.awaitPersisted;
        yield* grow(0);
        yield* TestClock.adjust("5 seconds");
        yield* writer.readSummary(WINDOW);
        yield* writer.awaitPersisted;
        const stored = yield* readStore(stateDir);
        assert.lengthOf(stored, 2);
        const delta = yield* newestSnapshot(stateDir);
        const full = stored.find(({ path }) => path !== delta.path)!;
        // Two copies of the writer's full save make the peer's first save a full one.
        yield* seedSnapshot(stateDir, full.raw);
        yield* seedSnapshot(stateDir, full.raw);
        const peer = yield* UsageService.make;
        yield* TestClock.adjust("5 seconds");
        yield* peer.readSummary(WINDOW);
        yield* peer.awaitPersisted;
        const compacted = yield* onlySnapshot(stateDir);
        assert.sameMembers(Object.keys(compacted.document.files), transcripts);

        yield* grow(1);
        yield* TestClock.adjust("5 seconds");
        yield* writer.readSummary(WINDOW);
        yield* writer.awaitPersisted;
        const saved = yield* newestSnapshot(stateDir);
        assert.deepStrictEqual(Object.keys(saved.document.files), [transcripts[1]]);
        assert.isTrue(yield* fs.exists(compacted.path));
        yield* Effect.forEach(transcripts, (file) => fs.remove(file), { discard: true });
        assert.strictEqual(yield* outputTokensAfterRestart, 114);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-cache-peer-compaction", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("compacts a large store in pieces with the event loop running between them", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          transcript,
          Array.from({ length: 40 }, (_, line) => claudeLine(line + 1, 5)).join(""),
        ),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        yield* outputTokensAfterRestart;
        const { document } = yield* onlySnapshot(stateDir);
        const row = document.files[transcript]!;
        const copies = Math.ceil((3 * SCAN_CACHE_PIECE_CHARS) / JSON.stringify(row).length);
        const elsewhere = NodePath.join(home, "elsewhere");
        const large = encodeUnknownJsonString({
          ...document,
          files: Object.fromEntries(
            Array.from({ length: copies }, (_, copy) => [
              NodePath.join(elsewhere, `${copy}.jsonl`),
              row,
            ]),
          ),
        });
        // Beside two equal large snapshots, the small one holds more than the largest alone.
        yield* seedSnapshot(stateDir, large);
        yield* seedSnapshot(stateDir, large);

        const writes: { turnedSince: boolean }[] = [];
        let turned = true;
        const watchingWrites: FileSystem.FileSystem = {
          ...fs,
          open: (file, options) =>
            Effect.map(fs.open(file, options), (handle) =>
              NodePath.dirname(file) !== storeDirOf(stateDir)
                ? handle
                : Object.assign(Object.create(handle) as FileSystem.File, {
                    writeAll: (buffer: Uint8Array) =>
                      Effect.suspend(() => {
                        writes.push({ turnedSince: turned });
                        turned = false;
                        setImmediate(() => {
                          turned = true;
                        });
                        return handle.writeAll(buffer);
                      }),
                  }),
            ),
        };
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, watchingWrites),
        );
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;

        assert.isAtLeast(writes.length, 3);
        assert.isTrue(writes.every(({ turnedSince }) => turnedSince));
        const { document: compacted } = yield* onlySnapshot(stateDir);
        assert.lengthOf(Object.keys(compacted.files), copies + 1);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-compaction", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("drops a pruned transcript's session from later snapshots", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const pruned = NodePath.join(NodePath.dirname(transcript), "pruned.jsonl");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(pruned, claudeLine(1, 5, "claude-fable-5", "session-pruned")),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(transcript, claudeLine(2, 7, "claude-fable-5", "session-kept")),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const service = yield* UsageService.make;
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        assert.sameMembers((yield* onlySnapshot(stateDir)).document.sessions, [
          "session-pruned",
          "session-kept",
        ]);

        yield* fs.remove(pruned);
        yield* TestClock.adjust("5 seconds");
        yield* service.readSummary(WINDOW);
        yield* service.awaitPersisted;
        yield* TestClock.adjust("93 days");
        const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
        yield* Effect.promise(async () => {
          await NodeFSP.appendFile(transcript, claudeLine(3, 4, "claude-fable-5", "session-kept"));
          await NodeFSP.utimes(transcript, nowSeconds, nowSeconds);
        });
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 11);
        yield* service.awaitPersisted;

        const { document } = yield* newestSnapshot(stateDir);
        assert.deepStrictEqual(document.sessions, ["session-kept"]);
        assert.deepStrictEqual(yield* storedFileKeys(stateDir), [transcript]);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-cache-pruned-session", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("retries a snapshot rename that a Windows lock blocks", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const locked = yield* Deferred.make<void>();
        let attempts = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              Effect.suspend(() =>
                isSnapshotPublish(stateDir, from, to) && attempts++ === 0
                  ? Deferred.succeed(locked, undefined).pipe(
                      Effect.andThen(Effect.fail(RENAME_LOCKED(to))),
                    )
                  : fs.rename(from, to),
              ),
          }),
        );
        yield* service.readSummary(WINDOW);
        yield* Deferred.await(locked);
        yield* TestClock.adjust("2 seconds");
        yield* service.awaitPersisted;

        const { path, document } = yield* onlySnapshot(stateDir);
        assert.deepStrictEqual(Object.keys(document.files), [transcript]);
        assert.deepStrictEqual(yield* fs.readDirectory(storeDirOf(stateDir)), [
          NodePath.basename(path),
        ]);
      }).pipe(Effect.provide(layerService({ prefix: "usage-cache-windows-lock", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps a snapshot from a newer version and reports it", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const bytes = encodeUnknownJsonString({
          version: USAGE_SCAN_CACHE_VERSION + 1,
          future: true,
        });
        const future = yield* seedSnapshot(stateDir, bytes);
        const service = yield* UsageService.make;
        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(summary), 5);
        assert.strictEqual(claudeSource(summary)?.status, "partial");
        assert.include(claudeSource(summary)?.message ?? "", "from a newer version");
        yield* service.awaitPersisted;
        assert.strictEqual(yield* fs.readFileString(future), bytes);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-cache-future-version", home, settings })),
      );
    }).pipe(Effect.scoped),
  );

  it.live.each(["first load", "persist"] as const)(
    "retries a saved snapshot the %s could not read",
    (stage) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const logs = captureLogs();
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const storeDir = storeDirOf(stateDir);
          let deny = false;
          const unread: string[] = [];
          if (stage === "first load") {
            const seed = yield* UsageService.make;
            yield* seed.readSummary(WINDOW);
            yield* seed.awaitPersisted;
            unread.push((yield* onlySnapshot(stateDir)).path);
            yield* fs.remove(transcript);
            deny = true;
          }
          const service = yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                deny && NodePath.dirname(file) === storeDir
                  ? Effect.fail(PERMISSION_DENIED("readFileString"))
                  : fs.readFileString(file, encoding),
            }),
          );
          yield* service.readSummary(WINDOW);
          yield* service.awaitPersisted;
          if (stage === "persist") {
            const { document } = yield* onlySnapshot(stateDir);
            const row = document.files[transcript]!;
            for (const [name, tokens] of [
              ["gone-a.jsonl", 7],
              ["gone-b.jsonl", 4],
            ] as const) {
              const records = row.r.map((record) => [...record]);
              records[0]![6] = tokens;
              records[0]![8] = `event-${name}`;
              unread.push(
                yield* seedSnapshot(
                  stateDir,
                  encodeUnknownJsonString({
                    ...document,
                    files: {
                      [NodePath.join(NodePath.dirname(transcript), name)]: { ...row, r: records },
                    },
                  }),
                ),
              );
            }
            deny = true;
            yield* TestClock.adjust("5 seconds");
            yield* service.readSummary(WINDOW);
            yield* service.awaitPersisted;
          }
          const partial = yield* service.readSummary(WINDOW);
          assert.strictEqual(claudeSource(partial)?.status, "partial");
          assert.include(
            claudeSource(partial)?.message ?? "",
            "Some saved usage could not be read.",
          );
          assert.sameMembers(
            logs
              .of("Error", "Could not read some saved transcript usage")
              .map((fields) => (fields as { path: string }).path),
            unread,
          );

          deny = false;
          yield* TestClock.adjust("1 minute");
          const recovered = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(recovered), stage === "persist" ? 16 : 5);
          assert.strictEqual(claudeSource(recovered)?.status, "ok");
          assert.sameDeepMembers(
            logs.of("Info", "Recovered saved transcript usage"),
            unread.map((path) => ({ path })),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layerService({ prefix: "usage-cache-read-gap", home, settings }),
              logs.layer,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each([
    { misses: 1, status: "ok" },
    { misses: Infinity, status: "partial" },
  ] as const)(
    "relists the store when a listed snapshot disappears ($misses misses)",
    ({ misses, status }) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const seed = yield* UsageService.make;
          yield* seed.readSummary(WINDOW);
          yield* seed.awaitPersisted;
          const { path: snapshot } = yield* onlySnapshot(stateDir);
          yield* fs.remove(transcript);
          let missed = 0;
          const service = yield* UsageService.make.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (file, encoding) =>
                Effect.suspend(() =>
                  file === snapshot && missed < misses
                    ? Effect.sync(() => missed++).pipe(
                        Effect.andThen(
                          Effect.fail(
                            PlatformError.systemError({
                              _tag: "NotFound",
                              module: "FileSystem",
                              method: "readFileString",
                            }),
                          ),
                        ),
                      )
                    : fs.readFileString(file, encoding),
                ),
            }),
          );
          const summary = yield* service.readSummary(WINDOW);
          assert.strictEqual(claudeSource(summary)?.status, status);
          if (status === "ok") assert.strictEqual(totalOutputTokens(summary), 5);
          else
            assert.include(
              claudeSource(summary)?.message ?? "",
              "Saved usage could not be listed.",
            );
          yield* service.awaitPersisted;
          assert.strictEqual(missed, status === "ok" ? 1 : 4);
        }).pipe(Effect.provide(layerService({ prefix: "usage-cache-relist", home, settings })));
      }).pipe(Effect.scoped),
  );

  it.live.each([
    { offset: 100, size: 0, expected: 12 },
    { offset: -100, size: 2000, expected: 5 },
    { offset: 0, size: 2000, expected: 5 },
    { offset: 0, size: 0, expected: 5 },
    { offset: 0, size: -1, expected: 5 },
  ])(
    "ranks a v9 row against the current one by when it was observed ($offset, $size)",
    ({ offset, size, expected }) =>
      Effect.gen(function* () {
        const { settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const sessions = NodePath.join(home, "codex", "sessions");
        const transcript = NodePath.join(sessions, "run.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sessions, { recursive: true });
          const lines = [
            { type: "session_meta", payload: { id: "cache-session", model_provider: "openai" } },
            { type: "turn_context", payload: { model: "gpt-6-astra" } },
            {
              type: "event_msg",
              timestamp: "2026-08-01T10:00:00Z",
              payload: {
                type: "token_count",
                info: { last_token_usage: { input_tokens: 0, output_tokens: 5 } },
              },
            },
          ];
          await NodeFSP.writeFile(
            transcript,
            lines.map((line) => encodeUnknownJsonString(line)).join("\n") + "\n",
          );
          await NodeFSP.utimes(transcript, CURSOR_NOW / 1000, CURSOR_NOW / 1000);
        });
        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const original = yield* UsageService.make;
          yield* original.readSummary(WINDOW);
          yield* original.awaitPersisted;
          const { document: saved } = yield* onlySnapshot(stateDir);
          const entry = saved.files[transcript]!;
          delete entry.oa;
          entry.m += offset;
          if (size < 0) entry.s = size;
          else entry.s += size;
          entry.r[0]![6] = 12;
          yield* fs.writeFileString(
            NodePath.join(stateDir, "usage-scan-cache-v9.json"),
            encodeUnknownJsonString({ ...saved, version: 9 }),
          );
          yield* fs.writeFileString(NodePath.join(stateDir, "usage-scan-cache-v8.json"), "{");
          yield* fs.remove(transcript);

          const service = yield* UsageService.make;
          const summary = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(summary), expected);
          assert.strictEqual(claudeSource(summary)?.status, "partial");
          yield* service.awaitPersisted;
          assert.isFalse((yield* fs.readDirectory(stateDir)).some(isLegacyScanCacheFileName));
          const damaged = (yield* readStore(stateDir)).filter(({ name }) =>
            name.startsWith("legacy-"),
          );
          assert.lengthOf(damaged, 1);
          assert.match(damaged[0]!.name, /-usage-scan-cache-v8\.json$/);
          assert.strictEqual(damaged[0]!.raw, "{");
          const restarted = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(WINDOW)), expected);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-cache-file-precedence", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("preserves saved tokens, costs and sessions after transcript cleanup and restart", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      const alias = NodePath.join(home, "claude-alias");
      yield* Effect.promise(() =>
        NodeFSP.symlink(NodePath.join(home, "claude"), alias, "junction"),
      );
      const content = claudeLine(1, 5);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, content));
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const first = yield* service.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(first), 5);
        assert.isAbove(first.buckets[0]?.costUsd ?? 0, 0);

        yield* Effect.promise(() => NodeFSP.rm(transcript));
        const deleted = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(deleted.buckets, first.buckets);
        assert.deepStrictEqual(deleted.sources, first.sources);

        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        const restored = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(restored.buckets, first.buckets);
        assert.deepStrictEqual(restored.sources, first.sources);

        yield* Effect.promise(() => NodeFSP.writeFile(transcript + ".jsonl", content));
        const moved = yield* restarted.readSummary(WINDOW);
        assert.deepStrictEqual(moved.buckets, first.buckets);
        assert.strictEqual(moved.sources[0]?.distinctSessions, 1);
        yield* restarted.awaitPersisted;

        const replacementProjects = NodePath.join(home, "replacement-projects");
        yield* Effect.promise(() => NodeFSP.mkdir(replacementProjects));
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
        );
        const afterRootCleanup = yield* UsageService.make;
        const missingRoot = yield* afterRootCleanup.readSummary(WINDOW);
        assert.deepStrictEqual(missingRoot.buckets, first.buckets);
        assert.strictEqual(missingRoot.sources[0]?.distinctSessions, 1);
        assert.strictEqual(missingRoot.sources[0]?.status, "ok");
        assert.deepStrictEqual(missingRoot.sources[0]?.fingerprint, first.sources[0]?.fingerprint);
        yield* Effect.promise(async () => {
          const projects = NodePath.join(home, "claude", "projects");
          await NodeFSP.rename(replacementProjects, projects);
          await NodeFSP.writeFile(NodePath.join(projects, "new.jsonl"), claudeLine(2, 7));
        });
        const recreated = yield* afterRootCleanup.readSummary(WINDOW);
        assert.strictEqual(totalOutputTokens(recreated), 12);
        assert.deepStrictEqual(recreated.sources[0]?.fingerprint, first.sources[0]?.fingerprint);

        const merged = mergeUsage(
          [
            {
              environmentId: EnvironmentId.make("cleanup-test"),
              label: "test",
              summary: recreated,
            },
            {
              environmentId: EnvironmentId.make("other-environment"),
              label: "before cleanup",
              summary: first,
            },
          ],
          missingRoot.contractVersion,
        );
        assert.strictEqual(merged.outputTokens, 12);
        assert.strictEqual(merged.sessions, 1);
        assert.strictEqual(merged.costUsd, recreated.buckets[0]?.costUsd);

        const outsideWindow = yield* restarted.readSummary({
          ...WINDOW,
          sinceDay: UsageDay.make("2026-08-02"),
        });
        assert.deepStrictEqual(outsideWindow.buckets, []);
        assert.strictEqual(outsideWindow.sources[0]?.distinctSessions, 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerService({
            prefix: "usage-service-cleanup-test",
            home,
            settings: {
              providerInstances: {
                ...settings.providerInstances,
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: alias },
                },
              },
            },
            ratesDocument: {
              "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live.each(["first copy deleted", "restart after cutoff"] as const)(
    "credits the same duplicate with the %s",
    (scenario) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const dir = NodePath.dirname(transcript);
        const first = NodePath.join(dir, "a.jsonl");
        const second = NodePath.join(dir, "b.jsonl");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(first, claudeLine(1, 5));
          await NodeFSP.writeFile(
            second,
            claudeLine(1, 5, "claude-fable-5", "session-2") +
              claudeLine(2, 7, "claude-fable-5", "session-2"),
          );
        });
        yield* Effect.gen(function* () {
          if (scenario === "restart after cutoff") {
            const actual = yield* Effect.promise(() =>
              vi.importActual<typeof NodeFSP>("node:fs/promises"),
            );
            const entered = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const readSecond = Promise.withResolvers<void>();
            yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
            using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
              if (args[0] === first) {
                entered.resolve();
                await release.promise;
              }
              return actual.open(...args);
            });
            const original = yield* UsageService.make;
            const base = yield* Effect.tracer;
            const tracer = Tracer.make({
              span(options) {
                const span = base.span(options);
                if (options.name === "UsageService.readFileRecords") {
                  const end = span.end.bind(span);
                  span.end = (time, exit) => {
                    end(time, exit);
                    if (Exit.isSuccess(exit)) readSecond.resolve();
                  };
                }
                return span;
              },
            });
            const caller = yield* original
              .readSummary(WINDOW)
              .pipe(Effect.withTracer(tracer), Effect.result, Effect.forkChild);
            yield* Effect.promise(() => Promise.all([entered.promise, readSecond.promise]));
            yield* TestClock.adjust("299 seconds");
            const cap = yield* original
              .readSummary({ ...WINDOW, awaitRefresh: true })
              .pipe(Effect.result, Effect.forkChild);
            yield* TestClock.adjust("1 second");
            const stopped = yield* Fiber.join(cap);
            assert.strictEqual(stopped._tag === "Failure" && stopped.failure.reason, "scanPending");
            yield* Fiber.join(caller);
            release.resolve();
            yield* original.awaitPersisted;
            const { stateDir } = yield* ServerConfig.ServerConfig;
            assert.deepStrictEqual(yield* storedFileKeys(stateDir), [second]);
          }

          const service = yield* UsageService.make;
          const live = yield* service.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(live), 12);
          assert.strictEqual(live.buckets[0]?.sessions, 2);
          yield* Effect.promise(() => NodeFSP.rm(first));
          const oneDeleted = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(oneDeleted.buckets, live.buckets);
          yield* Effect.promise(() => NodeFSP.rm(second));
          const bothDeleted = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(bothDeleted.buckets, live.buckets);
          yield* service.awaitPersisted;
          const restored = yield* (yield* UsageService.make).readSummary(WINDOW);
          assert.deepStrictEqual(restored.buckets, live.buckets);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-copy-order-test", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("scans a queued window after its first caller times out", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const dir = NodePath.join(home, "claude", "projects");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const queuedStarted = yield* Deferred.make<void>();
        const finishQueued = yield* Deferred.make<void>();
        let requests = 0;
        let scans = 0;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(ServerSettings.ServerSettingsService, {
            ...settingsService,
            getSettings: settingsService.getSettings.pipe(
              Effect.tap(() =>
                ++requests === 2 ? Deferred.succeed(waiting, undefined) : Effect.void,
              ),
            ),
          }),
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            exists: (path) => {
              if (path !== dir) return fileSystem.exists(path);
              const first = ++scans === 1;
              return Deferred.succeed(first ? entered : queuedStarted, undefined).pipe(
                Effect.andThen(Deferred.await(first ? release : finishQueued)),
                Effect.andThen(fileSystem.exists(path)),
              );
            },
          }),
        );
        const first = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        const narrow = yield* service
          .readSummary(NARROW_WINDOW)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(narrow);
        assert.strictEqual(result._tag === "Failure" && result.failure.reason, "scanPending");
        assert.strictEqual(scans, 1);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
        yield* Deferred.await(queuedStarted);
        const retry = yield* service
          .readSummary({ ...NARROW_WINDOW, awaitRefresh: true })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(finishQueued, undefined);
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(retry)), 0);
        assert.strictEqual(scans, 2);
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-service-serial-queries", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("retains completed transcript reads through repeated five-minute cutoffs", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      const dir = NodePath.dirname(transcript);
      const paths = Array.from({ length: 7 }, (_, index) =>
        NodePath.join(dir, `run-${index}.jsonl`),
      );
      yield* Effect.promise(() =>
        Promise.all(paths.map((path, index) => NodeFSP.writeFile(path, claudeLine(index, 1)))),
      );
      const listed = (yield* Effect.promise(() => NodeFSP.readdir(dir))).map((name) =>
        NodePath.join(dir, name),
      );
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      let blocked = new Set(listed.slice(-2));
      let entered = Promise.withResolvers<void>();
      let release = Promise.withResolvers<void>();
      using open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && blocked.has(args[0])) {
          entered.resolve();
          await release.promise;
        }
        return actual.open(...args);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const service = yield* UsageService.make;
        const base = yield* Effect.tracer;
        const cutOff = Effect.gen(function* () {
          const read = Promise.withResolvers<void>();
          let completed = 0;
          const tracer = Tracer.make({
            span(options) {
              const span = base.span(options);
              if (options.name === "UsageService.readFileRecords") {
                const end = span.end.bind(span);
                span.end = (time, exit) => {
                  end(time, exit);
                  if (Exit.isSuccess(exit) && ++completed === paths.length - blocked.size)
                    read.resolve();
                };
              }
              return span;
            },
          });
          const caller = yield* service
            .readSummary(WINDOW)
            .pipe(Effect.withTracer(tracer), Effect.result, Effect.forkChild);
          yield* Effect.promise(() => Promise.all([entered.promise, read.promise]));
          yield* TestClock.adjust("299 seconds");
          const cap = yield* service
            .readSummary({ ...WINDOW, awaitRefresh: true })
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("1 second");
          assert.strictEqual((yield* Fiber.join(cap))._tag, "Failure");
          assert.strictEqual((yield* Fiber.join(caller))._tag, "Failure");
          release.resolve();
          yield* service.awaitPersisted;
          return yield* storedFileKeys(stateDir);
        });
        const first = yield* cutOff;
        assert.isAbove(first.length, 0);
        assert.isBelow(first.length, paths.length);
        blocked = new Set(listed.slice(-1));
        entered = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        const second = yield* cutOff;
        assert.isAbove(second.length, first.length);
        assert.isBelow(second.length, paths.length);
        blocked.clear();
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), paths.length);
        yield* service.awaitPersisted;
        assert.sameMembers(yield* storedFileKeys(stateDir), listed);
        for (const path of first)
          assert.lengthOf(
            open.mock.calls.filter(([file]) => file === path),
            1,
          );
      }).pipe(Effect.provide(layerService({ prefix: "usage-scan-hard-cutoff", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps one transcript scan running past five minutes while bytes arrive", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const chunks = Array.from({ length: 3 }, () => ({
        reached: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      }));
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      let reads = 0;
      using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (args[0] !== transcript) return handle;
        reads++;
        const create = handle.createReadStream.bind(handle);
        handle.createReadStream = (options) => {
          const stream = create(options);
          const read = stream[Symbol.asyncIterator].bind(stream);
          stream[Symbol.asyncIterator] = async function* () {
            for await (const bytes of { [Symbol.asyncIterator]: read }) {
              for (const [index, chunk] of chunks.entries()) {
                chunk.reached.resolve();
                await chunk.release.promise;
                const width = Math.ceil(bytes.length / chunks.length);
                yield bytes.subarray(index * width, (index + 1) * width);
              }
            }
            return undefined;
          };
          return stream;
        };
        return handle;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const chunk of chunks) chunk.release.resolve();
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        const pending = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => chunks[0]!.reached.promise);
        chunks[0]!.release.resolve();
        yield* Effect.promise(() => chunks[1]!.reached.promise);
        yield* TestClock.adjust("3 minutes");
        chunks[1]!.release.resolve();
        yield* Effect.promise(() => chunks[2]!.reached.promise);
        yield* TestClock.adjust("3 minutes");
        const followUp = yield* service
          .readSummary({ ...WINDOW, awaitRefresh: true })
          .pipe(Effect.forkChild);
        chunks[2]!.release.resolve();
        assert.strictEqual(totalOutputTokens(yield* Fiber.join(followUp)), 5);
        assert.strictEqual(reads, 1);
        const initial = yield* Fiber.join(pending);
        assert.strictEqual(initial._tag === "Failure" && initial.failure.reason, "scanPending");
      }).pipe(
        Effect.provide(layerService({ prefix: "usage-scan-progress-timeout", home, settings })),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["progressing", "hung"] as const)(
    "keeps a %s directory walk under the stall watchdog",
    (scenario) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const root = NodePath.join(home, "claude", "projects");
        const parent = NodePath.dirname(transcript);
        const leaf = NodePath.join(parent, "nested");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(leaf);
          await NodeFSP.writeFile(NodePath.join(leaf, "session.jsonl"), claudeLine(1, 5));
        });
        const directories = [root, parent, leaf];
        const gates = directories.map(() => ({
          entered: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        }));
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        using walk = vi.spyOn(NodeFSP, "readdir").mockImplementation(async (...args) => {
          const index = typeof args[0] === "string" ? directories.indexOf(args[0]) : -1;
          const gate = gates[index];
          if (gate !== undefined) {
            gate.entered.resolve();
            await gate.release.promise;
          }
          return actual.readdir(...args);
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const gate of gates) gate.release.resolve();
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const caller = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => gates[0]!.entered.promise);
          for (let index = 0; index < 2; index++) {
            yield* TestClock.adjust("2 minutes");
            gates[index]!.release.resolve();
            yield* Effect.promise(() => gates[index + 1]!.entered.promise);
          }
          const initial = yield* Fiber.join(caller);
          assert.strictEqual(initial._tag === "Failure" && initial.failure.reason, "scanPending");

          if (scenario === "hung") {
            yield* TestClock.adjust("299 seconds");
            const atCutoff = yield* service
              .readSummary({ ...WINDOW, awaitRefresh: true })
              .pipe(Effect.result, Effect.forkChild);
            yield* TestClock.adjust("1 second");
            const stopped = yield* Fiber.join(atCutoff);
            assert.strictEqual(stopped._tag === "Failure" && stopped.failure.reason, "scanPending");
            assert.lengthOf(
              walk.mock.calls.filter(([directory]) => directory === root),
              1,
            );
            gates[2]!.release.resolve();
            assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 5);
            assert.lengthOf(
              walk.mock.calls.filter(([directory]) => directory === root),
              2,
            );
          } else {
            yield* TestClock.adjust("2 minutes");
            const followUp = yield* service
              .readSummary({ ...WINDOW, awaitRefresh: true })
              .pipe(Effect.forkChild);
            gates[2]!.release.resolve();
            assert.strictEqual(totalOutputTokens(yield* Fiber.join(followUp)), 5);
            for (const directory of directories) {
              assert.lengthOf(
                walk.mock.calls.filter(([name]) => name === directory),
                1,
              );
            }
          }
        }).pipe(Effect.provide(layerService({ prefix: "usage-discovery-stall", home, settings })));
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["progressing", "hung"] as const)(
    "keeps a %s transcript root probe under the stall watchdog",
    (scenario) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const extraHomes = [
          NodePath.join(home, "claude-extra-a"),
          NodePath.join(home, "claude-extra-b"),
        ];
        const roots = [
          NodePath.join(home, "claude", "projects"),
          ...extraHomes.map((dir) => NodePath.join(dir, "projects")),
        ];
        yield* Effect.promise(async () => {
          for (const root of roots.slice(1)) await NodeFSP.mkdir(root, { recursive: true });
          await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        });
        const gates = roots.map(() => ({
          entered: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        }));
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        using stat = vi.spyOn(NodeFSP, "stat").mockImplementation(async (...args) => {
          const index = typeof args[0] === "string" ? roots.indexOf(args[0]) : -1;
          if (index >= 0) {
            gates[index]!.entered.resolve();
            await gates[index]!.release.promise;
          }
          return actual.stat(...args);
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const gate of gates) gate.release.resolve();
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const caller = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => gates[0]!.entered.promise);
          for (let index = 0; index < 2; index++) {
            yield* TestClock.adjust("2 minutes");
            gates[index]!.release.resolve();
            yield* Effect.promise(() => gates[index + 1]!.entered.promise);
          }
          const initial = yield* Fiber.join(caller);
          assert.strictEqual(initial._tag === "Failure" && initial.failure.reason, "scanPending");

          if (scenario === "hung") {
            yield* TestClock.adjust("299 seconds");
            const atCutoff = yield* service
              .readSummary({ ...WINDOW, awaitRefresh: true })
              .pipe(Effect.result, Effect.forkChild);
            yield* TestClock.adjust("1 second");
            const stopped = yield* Fiber.join(atCutoff);
            assert.strictEqual(stopped._tag === "Failure" && stopped.failure.reason, "scanPending");
            assert.lengthOf(
              stat.mock.calls.filter(([directory]) => directory === roots[0]),
              1,
            );
            gates[2]!.release.resolve();
            assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 5);
            assert.lengthOf(
              stat.mock.calls.filter(([directory]) => directory === roots[0]),
              2,
            );
          } else {
            yield* TestClock.adjust("2 minutes");
            const followUp = yield* service
              .readSummary({ ...WINDOW, awaitRefresh: true })
              .pipe(Effect.forkChild);
            gates[2]!.release.resolve();
            assert.strictEqual(totalOutputTokens(yield* Fiber.join(followUp)), 5);
            for (const root of roots) {
              assert.lengthOf(
                stat.mock.calls.filter(([directory]) => directory === root),
                1,
              );
            }
          }
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-root-discovery-stall",
              home,
              settings: {
                ...settings,
                providerInstances: {
                  ...settings.providerInstances,
                  ...Object.fromEntries(
                    extraHomes.map((homePath, index) => [
                      ProviderInstanceId.make(`claude-extra-${index}`),
                      { driver: ProviderDriverKind.make("claudeAgent"), config: { homePath } },
                    ]),
                  ),
                },
              },
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each(["open", "stat"] as const)(
    "resets the stall watchdog when a transcript %s completes",
    (operation) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const beforeProgress = Promise.withResolvers<void>();
        const finishOperation = Promise.withResolvers<void>();
        const afterProgress = Promise.withResolvers<void>();
        const finishRead = Promise.withResolvers<void>();
        let opens = 0;
        using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
          if (args[0] !== transcript) return actual.open(...args);
          opens++;
          if (operation === "open") {
            beforeProgress.resolve();
            await finishOperation.promise;
          }
          const handle = await actual.open(...args);
          const stat = handle.stat.bind(handle);
          Object.defineProperty(handle, "stat", {
            value: async () => {
              if (operation === "stat") {
                beforeProgress.resolve();
                await finishOperation.promise;
              } else {
                afterProgress.resolve();
                await finishRead.promise;
              }
              return stat();
            },
          });
          if (operation === "stat") {
            const createStream = handle.createReadStream.bind(handle);
            handle.createReadStream = (options) => {
              const stream = createStream(options);
              const chunks = stream[Symbol.asyncIterator].bind(stream);
              stream[Symbol.asyncIterator] = async function* () {
                afterProgress.resolve();
                await finishRead.promise;
                return yield* { [Symbol.asyncIterator]: chunks };
              };
              return stream;
            };
          }
          return handle;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            finishOperation.resolve();
            finishRead.resolve();
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const caller = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
          yield* Effect.promise(() => beforeProgress.promise);
          yield* TestClock.adjust("3 minutes");
          finishOperation.resolve();
          yield* Effect.promise(() => afterProgress.promise);
          yield* TestClock.adjust("119 seconds");
          const followUp = yield* service
            .readSummary({ ...WINDOW, awaitRefresh: true })
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          finishRead.resolve();
          const result = yield* Fiber.join(followUp);
          assert.strictEqual(result._tag === "Success" && totalOutputTokens(result.success), 5);
          assert.strictEqual(opens, 1);
          const initial = yield* Fiber.join(caller);
          assert.strictEqual(initial._tag === "Failure" && initial.failure.reason, "scanPending");
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-file-operation-progress", home, settings })),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live(
    "keeps a compressed transcript read under the stall watchdog while it decodes nothing",
    () =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* TestClock.setTime(CURSOR_NOW);
        const compressed = `${transcript}.zst`;
        // A skippable Zstandard frame decodes to no output, so only its raw read shows progress.
        const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 0, 0, 0, 0]);
        const frames = [
          ...Array.from({ length: 10 }, () => skippable),
          NodeZlib.zstdCompressSync(claudeLine(1, 5)),
        ];
        yield* Effect.promise(() => NodeFSP.writeFile(compressed, Buffer.concat(frames)));
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const gates = frames.map(() => ({
          requested: Promise.withResolvers<void>(),
          release: Promise.withResolvers<void>(),
        }));
        let opens = 0;
        using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
          const handle = await actual.open(...args);
          if (args[0] !== compressed) return handle;
          opens++;
          let next = 0;
          Object.defineProperty(handle, "createReadStream", {
            value: () =>
              new NodeStream.Readable({
                highWaterMark: 0,
                read() {
                  const index = next++;
                  const gate = gates[index];
                  if (gate === undefined) {
                    this.push(null);
                    return;
                  }
                  gate.requested.resolve();
                  void gate.release.promise.then(() => this.push(frames[index]));
                },
              }),
          });
          return handle;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const gate of gates) gate.release.resolve();
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const caller = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
          // Ten frames two minutes apart span four stall intervals.
          for (const gate of gates.slice(0, -1)) {
            yield* Effect.promise(() => gate.requested.promise);
            yield* TestClock.adjust("2 minutes");
            gate.release.resolve();
          }
          const initial = yield* Fiber.join(caller);
          assert.strictEqual(initial._tag === "Failure" && initial.failure.reason, "scanPending");
          const last = gates.at(-1)!;
          yield* Effect.promise(() => last.requested.promise);
          const followUp = yield* service
            .readSummary({ ...WINDOW, awaitRefresh: true })
            .pipe(Effect.forkChild);
          last.release.resolve();
          const settled = yield* Fiber.join(followUp);
          assert.deepStrictEqual(
            { tokens: totalOutputTokens(settled), partialReason: settled.partialReason, opens },
            { tokens: 5, partialReason: undefined, opens: 1 },
          );
        }).pipe(
          Effect.provide(
            layerService({ prefix: "usage-compressed-read-progress", home, settings }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("answers around a transcript whose stat hangs without calling into its path again", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        await NodeFSP.writeFile(
          NodePath.join(NodePath.dirname(transcript), "other.jsonl"),
          claudeLine(2, 7),
        );
      });
      const actual = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      let hangNextOpen = false;
      let failNextOpen = false;
      let opens = 0;
      let stats = 0;
      let active = 0;
      let peak = 0;
      using _stat = vi.spyOn(NodeFSP, "stat").mockImplementation(async (...args) => {
        if (args[0] === transcript) stats++;
        return actual.stat(...args);
      });
      using _open = vi.spyOn(NodeFSP, "open").mockImplementation(async (...args) => {
        if (args[0] === transcript && failNextOpen) {
          failNextOpen = false;
          throw Object.assign(new Error("I/O error"), { code: "EIO" });
        }
        const handle = await actual.open(...args);
        if (args[0] !== transcript) return handle;
        opens++;
        peak = Math.max(peak, ++active);
        const hangs = hangNextOpen;
        hangNextOpen = false;
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          active--;
          if (hangs) closed.resolve();
        };
        if (hangs) {
          const stat = handle.stat.bind(handle);
          Object.defineProperty(handle, "stat", {
            value: async () => {
              entered.resolve();
              await release.promise;
              return stat();
            },
          });
        }
        return handle;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
      const logs = captureLogs();
      yield* Effect.gen(function* () {
        const service = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(WINDOW)), 12);
        yield* Effect.promise(() => NodeFSP.appendFile(transcript, claudeLine(3, 11)));
        hangNextOpen = true;
        const stuck = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => entered.promise);
        const callsWhenHung = { opens, stats };
        yield* TestClock.adjust("299 seconds");
        const atCutoff = yield* service
          .readSummary({ ...WINDOW, awaitRefresh: true })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(atCutoff)).partialReason, "scanTimedOut");
        yield* Fiber.join(stuck);

        for (let scan = 0; scan < 2; scan++) {
          const answered = yield* service.readSummary(WINDOW);
          assert.deepStrictEqual(
            {
              tokens: totalOutputTokens(answered),
              partialReason: answered.partialReason,
              status: claudeSource(answered)?.status,
              message: claudeSource(answered)?.message,
            },
            {
              tokens: 12,
              partialReason: undefined,
              status: "partial",
              message: "1 transcript path(s) could not be read; usage may be incomplete.",
            },
          );
        }
        assert.deepStrictEqual({ opens, stats }, callsWhenHung);

        release.resolve();
        yield* Effect.promise(() => closed.promise);
        failNextOpen = true;
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual(claudeSource(yield* service.readSummary(WINDOW))?.status, "partial");
        assert.deepStrictEqual(
          logs
            .of("Error", "Could not read transcript usage")
            .map((fields) => fields as { path: string; cause: Error })
            .map(({ path, cause }) => ({
              path,
              cause: cause instanceof PathCallPendingError ? "pending" : cause.message,
            })),
          [
            { path: transcript, cause: "pending" },
            { path: transcript, cause: "I/O error" },
          ],
        );
        yield* TestClock.adjust("5 seconds");
        const healthy = yield* service.readSummary(WINDOW);
        assert.deepStrictEqual(
          {
            tokens: totalOutputTokens(healthy),
            status: claudeSource(healthy)?.status,
            opens: opens - callsWhenHung.opens,
            peak,
          },
          { tokens: 23, status: "ok", opens: 1, peak: 1 },
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerService({ prefix: "usage-transcript-stuck-stat", home, settings }),
            logs.layer,
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("uses a completed window at the deadline only with matching pricing settings", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const dir = NodePath.join(home, "claude", "projects");
        let gate: { hit: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            exists: (file) =>
              file === dir && gate !== undefined
                ? Deferred.succeed(gate.hit, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.release)),
                    Effect.andThen(fs.exists(file)),
                  )
                : fs.exists(file),
          }),
        );
        assert.strictEqual((yield* service.readSummary(WINDOW)).buckets[0]?.costUsd, 0);
        yield* service.readSummary(NARROW_WINDOW);
        const slow = Effect.fn("UsageServiceTest.delayScan")(function* (waitForStall: boolean) {
          gate = { hit: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
          const pending = yield* service.readSummary(WINDOW).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(gate.hit);
          yield* TestClock.adjust("30 seconds");
          const result = yield* Fiber.join(pending);
          if (waitForStall) {
            yield* TestClock.adjust("269 seconds");
            const cap = yield* service
              .readSummary({ ...WINDOW, awaitRefresh: true })
              .pipe(Effect.forkChild);
            yield* TestClock.adjust("1 second");
            const stalled = yield* Fiber.join(cap);
            assert.strictEqual(stalled.partialReason, "scanTimedOut");
            assert.strictEqual(totalOutputTokens(stalled), 5);
          }
          yield* Deferred.succeed(gate.release, undefined);
          gate = undefined;
          return result;
        });
        const compatible = yield* slow(true);
        assert.isTrue(
          compatible._tag === "Success" && compatible.success.partialReason === "scanTimedOut",
        );
        yield* settingsService.updateSettings({
          usagePriceOverrides: {
            "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
          },
        });
        assert.strictEqual((yield* slow(false))._tag, "Failure");
        const updated = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.closeTo(updated.buckets[0]?.costUsd ?? -1, 0.00006, 1e-12);
      }).pipe(Effect.provide(layerService({ prefix: "usage-scan-deadline-keys", home, settings })));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("does not publish a cold snapshot while its pricing cache loads", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(CURSOR_NOW);
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")));
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const read = Promise.withResolvers<void>();
        const base = yield* Effect.tracer;
        const tracer = Tracer.make({
          span(options) {
            const span = base.span(options);
            if (options.name === "UsageService.readFileRecords") {
              const end = span.end.bind(span);
              span.end = (time, exit) => {
                end(time, exit);
                read.resolve();
              };
            }
            return span;
          },
        });
        const service = yield* UsageService.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (file, encoding) =>
              file.endsWith("usage-model-rates.json")
                ? Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fs.readFileString(file, encoding)),
                  )
                : fs.readFileString(file, encoding),
          }),
        );
        const pending = yield* service
          .readSummary(WINDOW)
          .pipe(Effect.withTracer(tracer), Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Effect.promise(() => read.promise);
        yield* TestClock.adjust("30 seconds");
        const priced = yield* Fiber.join(pending);
        assert.strictEqual(priced._tag === "Failure" && priced.failure.reason, "scanPending");
        yield* Deferred.succeed(release, undefined);
        const finished = yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
        assert.strictEqual(finished.buckets[0]?.costUsd, 5);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-scan-waits-for-prices",
            home,
            settings,
            ratesDocument: {
              "example-model": { input_cost_per_token: 0, output_cost_per_token: 1 },
            },
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live("keeps an absent directory missing when its cached files only contain diagnostics", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const mtimeMs = yield* Clock.currentTimeMillis;
        const cache = encodeSnapshot(
          new Map([
            [
              transcript,
              {
                size: 0,
                mtimeMs,
                observedAtMs: mtimeMs,
                provider: "claude" as const,
                records: [],
                tailRecords: [],
                malformedRecords: 2,
                position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
              },
            ],
          ]),
          {},
        );
        yield* seedSnapshot(stateDir, cache);
        const summary = yield* (yield* UsageService.make).readSummary(WINDOW);
        const source = summary.sources.find((source) => source.fingerprint.provider === "claude");
        assert.strictEqual(source?.status, "missing");
        assert.strictEqual(source?.scannedFiles, 0);
        assert.strictEqual(source?.malformedRecords, 2);
      }).pipe(
        Effect.provide(
          layerService({ prefix: "usage-service-missing-diagnostics", home, settings }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("reports saved usage of a removed directory only for windows it reaches", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-12T00:00:00Z"));
      const { transcript, settings, home } = yield* setup;
      // Saved usage is pruned after the retention window, so pin "now" near the write.
      yield* TestClock.setTime(Date.parse("2026-08-15T00:00:00Z"));
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        const lastWrite = Date.parse("2026-08-01T10:00:00Z") / 1000;
        await NodeFSP.utimes(transcript, lastWrite, lastWrite);
      });
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-saved-window-test", home, settings })),
      );
      const first = yield* service.readSummary(WINDOW);
      yield* Effect.promise(() =>
        NodeFSP.rm(NodePath.join(home, "claude", "projects"), { recursive: true }),
      );

      const reached = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(reached.buckets, first.buckets);
      assert.strictEqual(reached.sources[0]?.status, "ok");

      const later = yield* service.readSummary({
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-10"),
        untilDay: UsageDay.make("2026-08-12"),
      });
      assert.deepStrictEqual(later.buckets, []);
      assert.strictEqual(later.sources[0]?.status, "missing");
      assert.strictEqual(later.sources[0]?.scannedFiles, 0);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.live.each([
    { change: "custom prices", scans: 2, updatedCostUsd: 0.00006 },
    { change: "property order", scans: 1, updatedCostUsd: 0 },
  ] as const)(
    "shares an in-flight scan only while the usage settings match ($change)",
    ({ change, scans, updatedCostUsd }) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() =>
          NodeFSP.writeFile(transcript, claudeLine(1, 5, "example-model")),
        );
        const transcriptDir = yield* Effect.promise(() =>
          NodeFSP.realpath(NodePath.join(home, "claude", "projects")),
        );

        yield* Effect.gen(function* () {
          const settingsService = yield* ServerSettings.ServerSettingsService;
          const fileSystem = yield* FileSystem.FileSystem;
          const firstScanStarted = yield* Deferred.make<void>();
          const secondRead = yield* Deferred.make<void>();
          const releaseRates = yield* Deferred.make<void>();
          let homeProbes = 0;
          let reads = 0;
          const service = yield* UsageService.make.pipe(
            Effect.provideService(ServerSettings.ServerSettingsService, {
              ...settingsService,
              getSettings: settingsService.getSettings.pipe(
                Effect.map((current) => {
                  reads += 1;
                  if (change !== "property order" || reads === 1) return current;
                  const providerInstances = Object.fromEntries(
                    Object.entries(current.providerInstances).reverse(),
                  ) as typeof current.providerInstances;
                  return { ...current, providerInstances };
                }),
                Effect.tap(() =>
                  reads === 2 ? Deferred.succeed(secondRead, undefined) : Effect.void,
                ),
              ),
            }),
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              exists: (path) =>
                fileSystem.exists(path).pipe(
                  Effect.tap(() => {
                    if (path !== transcriptDir) return Effect.void;
                    homeProbes += 1;
                    return Deferred.succeed(firstScanStarted, undefined);
                  }),
                ),
            }),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Deferred.await(releaseRates).pipe(
                  Effect.as(HttpClientResponse.fromWeb(request, Response.json({}))),
                ),
              ),
            ),
          );

          const first = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          yield* Deferred.await(firstScanStarted);
          if (change === "custom prices") {
            yield* settingsService.updateSettings({
              usagePriceOverrides: {
                "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
              },
            });
          }
          const second = yield* service.readSummary(WINDOW).pipe(Effect.forkChild);
          // The first scan holds until the second read has its settings, so the second joins it
          // or queues its own scan instead of finding it already finished.
          yield* Deferred.await(secondRead);
          yield* Deferred.succeed(releaseRates, undefined);

          const original = yield* Fiber.join(first);
          const updated = yield* Fiber.join(second);
          assert.strictEqual(homeProbes, scans);
          assert.strictEqual(original.buckets[0]?.costUsd, 0);
          assert.closeTo(updated.buckets[0]?.costUsd ?? -1, updatedCostUsd, 1e-12);
        }).pipe(
          Effect.provide(layerService({ prefix: "usage-service-price-race-test", home, settings })),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("changes the client settings key with a secret value it does not reveal", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const codex = ProviderInstanceId.make("codex");
      const withToken = (value: string) => ({
        ...settings.providerInstances,
        [codex]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: NodePath.join(home, "codex") },
          environment: [{ name: "OPENAI_API_KEY", value, sensitive: true }],
        },
      });

      yield* Effect.gen(function* () {
        const settingsService = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make;
        const before = yield* settingsService.getSettings;
        const after = yield* settingsService.updateSettings({
          providerInstances: withToken("sk-second-token"),
        });
        assert.deepEqual(
          ServerSettings.redactServerSettingsForClient(after),
          ServerSettings.redactServerSettingsForClient(before),
        );

        const keys = [service.clientSettingsKey(before), service.clientSettingsKey(after)];
        assert.notStrictEqual(keys[1], keys[0]);
        for (const key of keys) {
          assert.notInclude(key, "sk-first-token");
          assert.notInclude(key, "sk-second-token");
        }
        const otherServer = yield* UsageService.make.pipe(Effect.provide(serverKey(2)));
        assert.notStrictEqual(otherServer.clientSettingsKey(after), keys[1]);
      }).pipe(
        Effect.provide(
          layerService({
            prefix: "usage-service-settings-key-test",
            home,
            settings: { ...settings, providerInstances: withToken("sk-first-token") },
          }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live.each(["network", "http", "invalidJson", "empty"] as const)(
    "recovers pricing through the GitHub API after a %s failure",
    (failure) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const ratesDocument = {
          "claude-fable-5": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 },
        };
        const serviceLayer = layerService({
          prefix: `usage-service-rates-fallback-${failure}-test`,
          home,
          settings,
          onRatesFetch: (request) => requests.push(request),
          ratesResponse: (request) => {
            if (request.url.startsWith("https://api.github.com/")) {
              return Effect.succeed(Response.json(ratesDocument));
            }
            if (failure === "network") {
              return Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({
                    request,
                    cause: new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com"),
                  }),
                }),
              );
            }
            return Effect.succeed(
              failure === "invalidJson"
                ? new Response("not JSON")
                : Response.json({}, { status: failure === "http" ? 503 : 200 }),
            );
          },
        });
        const service = yield* UsageService.make.pipe(Effect.provide(serviceLayer));

        const summary = yield* service.readSummary(WINDOW);
        assert.strictEqual(summary.pricing.status, "fresh");
        assert.strictEqual(summary.pricing.knownModels, 1);
        assert.closeTo(summary.buckets[0]?.costUsd ?? -1, 0.00035, 1e-12);
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [
            "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
            "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main",
          ],
        );
        assert.strictEqual(requests[1]?.headers.accept, "application/vnd.github.raw+json");

        const restarted = yield* UsageService.make.pipe(Effect.provide(serviceLayer));
        const cached = yield* restarted.readSummary(WINDOW);
        assert.strictEqual(cached.pricing.status, "cached");
        assert.deepStrictEqual(cached.buckets, summary.buckets);
        assert.strictEqual(requests.length, 2);
      }).pipe(Effect.scoped),
  );

  it.live("does not orphan an in-flight scan when its first caller is interrupted", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const service = yield* UsageService.make.pipe(
        Effect.provide(layerService({ prefix: "usage-service-interruption-test", home, settings })),
      );

      let orphanedAt: number | undefined;
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- Fixed-count scheduler interruption matrix; each iteration exercises a different interruption point.
      for (let interruptAt = 1; interruptAt <= 31; interruptAt += 1) {
        const tasks: Array<() => void> = [];
        const dispatcher: Scheduler.SchedulerDispatcher = {
          scheduleTask: (task) => tasks.push(task),
          flush: () => {
            let task: (() => void) | undefined;
            while ((task = tasks.shift()) !== undefined) task();
          },
        };

        let requestFiber: Fiber.Fiber<unknown, unknown> | undefined;
        let requestChecks = 0;
        const scheduler: Scheduler.Scheduler = {
          executionMode: "async",
          makeDispatcher: () => dispatcher,
          shouldYield: (fiber) => {
            if (fiber !== requestFiber) return false;
            requestChecks += 1;
            if (requestChecks !== interruptAt) return false;
            fiber.interruptUnsafe();
            return true;
          },
        };

        const input: UsageSummaryInput = {
          ...WINDOW,
          sinceDay: UsageDay.make("2026-09-01"),
          untilDay: UsageDay.make(`2026-08-${String(interruptAt).padStart(2, "0")}`),
        };
        const first = yield* service
          .readSummary(input)
          .pipe(
            Effect.exit,
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild,
          );
        requestFiber = first;
        yield* Effect.yieldNow;
        dispatcher.flush();

        const second = yield* service.readSummary(input).pipe(
          Effect.match({
            onFailure: (error) => error.reason,
            onSuccess: () => "success" as const,
          }),
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        dispatcher.flush();
        const secondExit = second.pollUnsafe();
        if (secondExit === undefined) {
          second.interruptUnsafe();
          orphanedAt = interruptAt;
          break;
        }
        if (Exit.isFailure(secondExit)) {
          assert.fail("the matching request fiber was interrupted");
        }
        assert.strictEqual(secondExit.value, "invalidWindow");
      }

      assert.isUndefined(
        orphanedAt,
        `interruption left the next matching request pending at scheduler check ${orphanedAt}`,
      );
    }).pipe(Effect.scoped),
  );
});
