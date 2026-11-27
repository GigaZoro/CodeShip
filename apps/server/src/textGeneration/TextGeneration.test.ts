import type { RunResult } from "@cursor/sdk";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { OnDispatch } from "@t3tools/provider-core/server/textGenerationOperations";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import { makeCursorTextGeneration } from "@t3tools/provider-cursor/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TextGenerationUsageRepository from "../persistence/TextGenerationUsage.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { TextGenerationAttribution, TextGenerationUsageSink } from "./TextGenerationUsage.ts";

const CURSOR = ProviderInstanceId.make("cursor_work");
const FAKE = ProviderInstanceId.make("claude_work");
const DEMAND = `demand:${"d".repeat(64)}`;
const THREAD = ThreadId.make("thread:usage");
const TITLE_INPUT = { cwd: "/workspace", message: "Name this thread", linkedContext: "" };

interface CursorRun {
  readonly status: "running" | "finished";
  readonly cancel: () => Promise<void>;
  readonly wait: () => Promise<RunResult>;
}

const finishedRun = (result: Partial<RunResult> | (() => Promise<RunResult>)): CursorRun => ({
  status: "running",
  cancel: async () => {},
  wait:
    typeof result === "function"
      ? result
      : () => Promise.resolve({ id: "run", status: "finished", ...result }),
});

const cursorSettings = Schema.decodeSync(CursorSettings)({ enabled: true });

const snapshotOf = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => {
  const snapshot: ServerProvider = {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "1970-01-01T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return { getSnapshot: Effect.succeed(snapshot) } as ProviderInstance["snapshot"];
};

const instanceOf = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  textGeneration: ProviderInstance["textGeneration"],
): ProviderInstance => ({
  instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: instanceId },
  displayName: undefined,
  enabled: true,
  snapshot: snapshotOf(instanceId, driver),
  orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
  textGeneration,
});

/** Runs production Cursor text generation and a scripted provider through `TextGeneration` and SQLite. */
const makeHarness = Effect.fn(function* (options: {
  readonly send: (prompt: string) => Promise<CursorRun>;
  readonly fake?: ProviderInstance["textGeneration"];
}) {
  let sandboxPolicy = false;
  const send = vi.fn(options.send);
  const cursorSdk = Layer.mock(CursorSdk.CursorSdk)({
    load: () =>
      ({
        Agent: {
          create: async () => ({ send, [Symbol.asyncDispose]: async () => {} }),
        },
      }) as unknown as ReturnType<CursorSdk.CursorSdk["Service"]["load"]>,
    loadSqlite: () =>
      ({
        SqliteLocalAgentStore: { open: async () => ({ dispose: async () => {} }) },
      }) as unknown as ReturnType<CursorSdk.CursorSdk["Service"]["loadSqlite"]>,
  });
  const fileSystem = FileSystem.layerNoop({
    exists: () => Effect.succeed(sandboxPolicy),
    makeTempDirectoryScoped: () => Effect.succeed("/isolated-text-generation"),
  });
  const cursor = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" }).pipe(
    Effect.provide(Layer.merge(fileSystem, cursorSdk)),
  );
  const instances = [
    instanceOf(CURSOR, ProviderDriverKind.make("cursor"), cursor),
    ...(options.fake
      ? [instanceOf(FAKE, ProviderDriverKind.make("claudeAgent"), options.fake)]
      : []),
  ];
  const written = yield* Queue.unbounded<void>();
  const repository = yield* TextGenerationUsageRepository.make;
  const service = yield* TextGeneration.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed(instances),
          getInstance: (id) =>
            Effect.succeed(instances.find((instance) => instance.instanceId === id)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("unused"),
        }),
        Layer.succeed(TextGenerationUsageRepository.TextGenerationUsageRepository, {
          record: (rows) =>
            repository.record(rows).pipe(Effect.tap(() => Queue.offer(written, undefined))),
        }),
      ),
    ),
  );
  const sql = yield* SqlClient.SqlClient;
  return {
    send,
    service,
    written,
    setSandboxPolicy: (present: boolean) => {
      sandboxPolicy = present;
    },
    rows: sql`
      SELECT driver, provider_instance_id, operation, model, thread_id, demand_id,
        input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, outcome, error_detail
      FROM text_generation_usage ORDER BY usage_id
    `,
  };
});

const attributed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TextGenerationAttribution, { threadId: THREAD, demandId: DEMAND }),
  );

const unknownRow = (outcome: string, errorDetail: string | null) => ({
  driver: "cursor",
  provider_instance_id: CURSOR,
  operation: "generateThreadTitle",
  model: "composer-2",
  thread_id: THREAD,
  demand_id: DEMAND,
  input_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  output_tokens: null,
  outcome,
  error_detail: errorDetail,
});

const cursorTitle = { ...TITLE_INPUT, modelSelection: { instanceId: CURSOR, model: "composer-2" } };

describe("TextGeneration usage accounting", () => {
  it.effect("writes no row for a rejected preflight and one unknown row for an invalid reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        send: async () => finishedRun({ result: '{"title":123}' }),
      });

      harness.setSandboxPolicy(true);
      const rejected = yield* Effect.flip(
        attributed(harness.service.generateThreadTitle(cursorTitle)),
      );
      expect(rejected.detail).toContain("custom ~/.cursor/sandbox.json");
      expect(harness.send).not.toHaveBeenCalled();
      expect(yield* harness.rows).toEqual([]);

      harness.setSandboxPolicy(false);
      const invalid = yield* Effect.flip(
        attributed(harness.service.generateThreadTitle(cursorTitle)),
      );
      expect(invalid).toBeInstanceOf(TextGenerationError);
      expect(invalid.operation).toBe("generateThreadTitle");
      expect(invalid.detail).toBe("Cursor SDK returned invalid structured output.");
      expect(harness.send).toHaveBeenCalledOnce();
      expect(yield* harness.rows).toEqual([
        unknownRow("failed", "Cursor SDK returned invalid structured output."),
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect.each([
    { name: "a valid reply", run: { result: '{"title":"Fix spinner"}' }, error: null },
    {
      name: "a run that ends with an error",
      run: { status: "error", result: '{"title":"Partial"}' },
      error: "Cursor SDK request finished with an error.",
    },
    {
      name: "a wait that rejects",
      run: () => Promise.reject(new Error("socket closed")),
      error: "Cursor SDK text generation failed.",
    },
  ] as const)("writes exactly one row after dispatch for $name", ({ run, error }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        send: async () => finishedRun(run as Partial<RunResult> | (() => Promise<RunResult>)),
      });
      const exit = yield* Effect.exit(attributed(harness.service.generateThreadTitle(cursorTitle)));
      if (error === null) {
        expect(exit).toEqual(Exit.succeed({ title: "Fix spinner" }));
      } else {
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ detail: error });
      }
      expect(yield* harness.rows).toEqual([
        unknownRow(error === null ? "succeeded" : "failed", error),
      ]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect.each([true, false])(
    "keeps reported counts, measured zero and unknown nulls once (succeeds=%s)",
    (succeeds) =>
      Effect.gen(function* () {
        const reportingRunner: ProviderInstance["textGeneration"]["generateThreadTitle"] = () =>
          Effect.gen(function* () {
            (yield* OnDispatch)();
            (yield* TextGenerationUsageSink)([
              {
                model: "claude-haiku",
                inputTokens: 120,
                cacheReadTokens: 0,
                cacheWriteTokens: null,
                outputTokens: 0,
              },
            ]);
            return succeeds
              ? { title: "Measured" }
              : yield* new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "Claude returned invalid structured output.",
                  retryable: false,
                });
          });
        const harness = yield* makeHarness({
          send: async () => finishedRun({}),
          fake: { generateThreadTitle: reportingRunner } as ProviderInstance["textGeneration"],
        });
        const exit = yield* Effect.exit(
          attributed(
            harness.service.generateThreadTitle({
              ...TITLE_INPUT,
              modelSelection: { instanceId: FAKE, model: "claude-haiku" },
            }),
          ),
        );
        expect(Exit.isSuccess(exit)).toBe(succeeds);
        if (!succeeds) {
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
            detail: "Claude returned invalid structured output.",
            retryable: false,
          });
        }
        expect(yield* harness.rows).toEqual([
          {
            driver: "claudeAgent",
            provider_instance_id: FAKE,
            operation: "generateThreadTitle",
            model: "claude-haiku",
            thread_id: THREAD,
            demand_id: DEMAND,
            input_tokens: 120,
            cache_read_tokens: 0,
            cache_write_tokens: null,
            output_tokens: 0,
            outcome: succeeds ? "succeeded" : "failed",
            error_detail: succeeds ? null : "Claude returned invalid structured output.",
          },
        ]);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("stays interrupted and records a send the SDK accepts after interruption", () =>
    Effect.gen(function* () {
      let accept: (run: CursorRun) => void = () => {};
      let sent: () => void = () => {};
      const sendStarted = new Promise<void>((resolve) => {
        sent = resolve;
      });
      const cancel = vi.fn(async () => {});
      const harness = yield* makeHarness({
        send: () => {
          sent();
          return new Promise<CursorRun>((resolve) => {
            accept = resolve;
          });
        },
      });
      const fiber = yield* Effect.forkChild(
        attributed(harness.service.generateThreadTitle(cursorTitle)),
      );
      yield* Effect.promise(() => sendStarted);
      yield* Fiber.interrupt(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(yield* harness.rows).toEqual([]);

      accept({ ...finishedRun({}), cancel });
      yield* Queue.take(harness.written);
      expect(cancel).toHaveBeenCalledOnce();
      expect(yield* harness.rows).toEqual([unknownRow("interrupted", null)]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
