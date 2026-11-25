// @effect-diagnostics nodeBuiltinImport:off
import type { AgentOptions, SDKModel } from "@cursor/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Deferred from "effect/Deferred";

import { CURSOR_ACCOUNT_TTL_MS } from "./accountCache.ts";

import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffBudget,
} from "@t3tools/provider-core/server/handoffBudget";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CursorDriver } from "./driver.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { loadCursorSdk } from "./sdk.ts";

const { Cursor } = loadCursorSdk();

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(CursorSdk.layer),
  Layer.provideMerge(
    Layer.mock(CursorAgentSdk.CursorAgentSdkRunner)({
      open: () => Effect.die("Maintenance resolution must not open a Cursor session"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("The driver test must not read the Keychain"),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Cursor must not make an HTTP request")),
    ),
  ),
);

const captureWarnings = (warnings: Queue.Queue<ReadonlyArray<unknown>>) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn" && Array.isArray(message)) Queue.offerUnsafe(warnings, message);
    }),
  ]);

it.layer(layerTest)("CursorDriver", (it) => {
  it.effect(
    "publishes history access without waiting on cursor.com and withdraws it only for a rejected or missing login",
    () =>
      Effect.gen(function* () {
        const settings = yield* TestProviderHost.TestProviderHostSettings;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const token = "header.eyJzdWIiOiJjdXJzb3J8Zml4dHVyZSJ9.signature";
        const authFile = path.join(directory, "cursor", "auth.json");
        const warnings = yield* Queue.unbounded<ReadonlyArray<unknown>>();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.makeDirectory(path.join(directory, ".cursor"));
        for (const [platform, environment, keychainEnabled, expected] of [
          ["darwin", { HOME: directory }, false, "keychainOff"],
          ["darwin", { HOME: directory }, true, "reading"],
          ["darwin", { HOME: path.join(directory, "missing") }, true, "unavailable"],
          ["linux", { XDG_CONFIG_HOME: directory }, false, "reading"],
          ["linux", { XDG_CONFIG_HOME: path.join(directory, "missing") }, false, "unavailable"],
          ["darwin", { AGENT_CLI_CREDENTIAL_STORE: "memory" }, false, "unavailable"],
          [
            "linux",
            { CURSOR_AUTH_TOKEN: "test-token", XDG_CONFIG_HOME: directory },
            false,
            "unavailable",
          ],
        ] as const) {
          yield* Effect.gen(function* () {
            yield* fs.writeFileString(authFile, JSON.stringify({ accessToken: token }));
            yield* settings.set({
              ...DEFAULT_SERVER_SETTINGS,
              cursorKeychainUsageEnabled: keychainEnabled,
            });
            let keychainToken: string | null | "unreadable" = token;
            let answer: number | "offline" | "silent" = 200;
            const asked = Deferred.makeUnsafe<void>();
            let requests = 0;
            let keychainReads = 0;
            const history = HttpClient.make((request) => {
              expect(request.url).toBe(
                "https://cursor.com/api/dashboard/get-filtered-usage-events",
              );
              requests++;
              if (answer === "silent")
                return Deferred.succeed(asked, undefined).pipe(Effect.andThen(Effect.never));
              if (answer === "offline")
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request, description: "offline" }),
                  }),
                );
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ totalUsageEventsCount: 0 }, { status: answer }),
                ),
              );
            });
            const instance = yield* CursorDriver.create({
              instanceId: ProviderInstanceId.make("cursor-history"),
              displayName: "Cursor",
              enabled: true,
              environment: [],
              config: CursorDriver.defaultConfig(),
            }).pipe(
              Effect.provideService(HostProcess.Platform, platform),
              Effect.provideService(HostProcess.Environment, environment),
              Effect.provideService(HttpClient.HttpClient, history),
              Effect.provideService(CursorKeychain.CursorKeychain, {
                accessToken: Effect.suspend(() => {
                  keychainReads++;
                  return keychainToken === "unreadable"
                    ? Effect.fail(new CursorKeychain.CursorKeychainReadError({ cause: "locked" }))
                    : Effect.succeed(keychainToken);
                }),
              }),
            );
            const changes = yield* Stream.toPull(instance.snapshot.streamChanges);
            const published = Effect.fn("published")(function* (
              state: NonNullable<ServerProvider["cursorAccountHistory"]>,
            ) {
              while ((yield* instance.snapshot.getSnapshot).cursorAccountHistory !== state) {
                yield* changes;
              }
            });
            const recheck = Effect.fn("recheck")(function* (next: typeof answer) {
              answer = next;
              yield* TestClock.adjust(CURSOR_ACCOUNT_TTL_MS);
              return (yield* instance.snapshot.refresh).cursorAccountHistory;
            });
            const keepsReading = Effect.fn("keepsReading")(function* (cause: string) {
              expect(yield* Queue.take(warnings)).toEqual([
                "Cursor account history check failed; keeping the last result.",
                { reason: expect.stringContaining(cause) },
              ]);
              expect((yield* instance.snapshot.getSnapshot).cursorAccountHistory).toBe("reading");
            });
            expect((yield* instance.snapshot.getSnapshot).cursorAccountHistory).toBe("unavailable");
            if (expected !== "reading") {
              expect((yield* instance.snapshot.refresh).cursorAccountHistory).toBe(expected);
              expect(requests).toBe(0);
              if (!keychainEnabled) expect(keychainReads).toBe(0);
              return;
            }
            yield* published("reading");

            // The status publish returns while cursor.com has not answered.
            expect(yield* recheck("silent")).toBe("reading");
            yield* Deferred.await(asked);
            yield* TestClock.adjust("10 seconds");
            yield* keepsReading("10 seconds");
            answer = 503;
            yield* instance.snapshot.refresh;
            yield* keepsReading("HTTP 503");
            answer = "offline";
            yield* instance.snapshot.refresh;
            yield* keepsReading("offline");
            answer = 200;
            keychainToken = "unreadable";
            yield* fs.writeFileString(authFile, "{");
            yield* instance.snapshot.refresh;
            yield* keepsReading("could not be read");
            keychainToken = token;
            yield* fs.writeFileString(authFile, JSON.stringify({ accessToken: token }));

            for (const [next, state] of [
              [401, "unavailable"],
              [200, "reading"],
              [403, "unavailable"],
              [200, "reading"],
            ] as const) {
              yield* recheck(next);
              yield* published(state);
            }
            const requestsWithLogin = requests;
            keychainToken = null;
            yield* fs.writeFileString(authFile, JSON.stringify({}));
            yield* recheck(200);
            yield* published("unavailable");
            expect(requests).toBe(requestsWithLogin);
            if (!keychainEnabled) expect(keychainReads).toBe(0);
          }).pipe(Effect.scoped, Effect.provide(captureWarnings(warnings)));
        }
      }),
  );
  it.effect(
    "persists browser credentials, uses them for chat, and closes the SDK session on logout",
    () =>
      Effect.gen(function* () {
        const login = vi.spyOn(Cursor.auth, "login").mockImplementation(async (options) => {
          options?.onLoginUrl?.("https://cursor.com/loginDeepControl?challenge=test-only");
          await options?.store?.save({
            version: 1,
            backendUrl: "https://api2.cursor.sh",
            apiKey: "instance-browser-key",
            createdAtMs: 0,
            apiKeyExpiresAtMs: 4_000_000_000_000,
            email: "cursor@example.com",
          });
          return { apiKey: "instance-browser-key", apiKeyExpiresAtMs: 4_000_000_000_000 };
        });
        const requests: Array<{ url: string; authorization: string | undefined }> = [];
        const client = HttpClient.make((request) => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                request.url.endsWith("/v1/me")
                  ? {
                      apiKeyName: "T3.CodeShip",
                      createdAt: "2026-01-01T00:00:00.000Z",
                      userEmail: "cursor@example.com",
                    }
                  : { items: [{ id: "auto", displayName: "Auto" }] },
              ),
            ),
          );
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            login.mockRestore();
          }),
        );
        const input = {
          instanceId: ProviderInstanceId.make("cursor-browser-persisted"),
          displayName: "Personal Cursor",
          enabled: true,
          environment: [{ name: "CURSOR_API_KEY", value: "", sensitive: true }],
          config: CursorDriver.defaultConfig(),
        };
        const openedKeys: Array<string | undefined> = [];
        let closed = 0;
        const instance = yield* CursorDriver.create(input).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: (request) =>
              Effect.sync(() => {
                openedKeys.push(request.options.apiKey);
                return {
                  agentId: "browser-auth-agent",
                  listMessages: Effect.succeed([]),
                  send: () => Effect.die("This test only opens a session"),
                  close: Effect.sync(() => {
                    closed += 1;
                  }),
                };
              }),
          }),
        );
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unauthenticated");
        yield* instance.auth!.start("client");
        yield* instance.auth!.subscribe("client").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(requests).toContainEqual({
          url: "https://api.cursor.com/v1/me",
          authorization: "Bearer instance-browser-key",
        });
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          status: "ready",
          auth: {
            status: "authenticated",
            type: "browser",
            canLogout: true,
            email: "cursor@example.com",
          },
          setup: { canAuthenticate: true, canInstall: false },
        });
        const threadId = ThreadId.make("cursor-browser-thread");
        const modelSelection = { instanceId: input.instanceId, model: "auto" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const runtime = yield* instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-browser-session"),
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(0);
        const recreated = yield* CursorDriver.create(input).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("authenticated");
        yield* instance.auth!.logout(Effect.void);
        expect(closed).toBe(1);
        expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
        expect((yield* recreated.snapshot.refresh).auth.status).toBe("unauthenticated");
        expect(
          (yield* Effect.exit(runtime.ensureThread({ threadId, modelSelection, runtimePolicy })))
            ._tag,
        ).toBe("Failure");
        expect(openedKeys).toEqual(["instance-browser-key"]);
        expect(closed).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("budgets handoffs for the SDK model across catalog refreshes and option changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-window-" });
      const catalog = yield* Deferred.make<Array<SDKModel>>();
      const catalogRequested = yield* Deferred.make<void>();
      let failUser = false;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/v1/me"))
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                failUser
                  ? { error: { message: "Cursor is unreachable" } }
                  : { apiKeyName: "T3.CodeShip", createdAt: "2026-01-01T00:00:00.000Z" },
                { status: failUser ? 503 : 200 },
              ),
            );
          yield* Deferred.succeed(catalogRequested, undefined);
          const models = yield* Deferred.await(catalog);
          return HttpClientResponse.fromWeb(request, Response.json({ items: models }));
        }),
      );
      const instanceId = ProviderInstanceId.make("cursor-catalog-window");
      const openedModels: Array<AgentOptions["model"]> = [];
      const sentModels: Array<AgentOptions["model"]> = [];
      const instance = yield* CursorDriver.create({
        instanceId,
        displayName: "Cursor",
        enabled: true,
        environment: [{ name: "CURSOR_API_KEY", value: "catalog-window-key", sensitive: true }],
        config: CursorDriver.defaultConfig(),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (request) =>
            Effect.sync(() => {
              openedModels.push(request.options.model);
              return {
                agentId: "native-cursor-window",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.sync(() => {
                    sentModels.push(input.options?.model);
                    const runId = `native-cursor-window-run-${sentModels.length}`;
                    return {
                      agentId: "native-cursor-window",
                      runId,
                      cancel: Effect.void,
                      wait: Effect.succeed({
                        id: runId,
                        requestId: runId,
                        status: "finished" as const,
                        model: { id: "claude-opus-5-5" },
                        durationMs: 1,
                      }),
                    };
                  }),
              };
            }),
        }),
      );
      const selection = (contextWindow?: string) => ({
        instanceId,
        model: "claude-opus-5-5",
        ...(contextWindow === undefined
          ? {}
          : { options: [{ id: "contextWindow", value: contextWindow }] }),
      });
      const threadId = ThreadId.make("cursor-catalog-window-thread");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const runtime = yield* instance.orchestrationAdapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-catalog-window-session"),
        modelSelection: selection("1m"),
        runtimePolicy,
      });
      const refresh = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
      yield* Deferred.await(catalogRequested);
      expect(runtime.getModelContextWindow?.(selection())).toBeUndefined();
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: selection("1m"),
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const startTurn = Effect.fnUntraced(function* (contextWindow?: string) {
        const modelSelection = selection(contextWindow);
        const ordinal = sentModels.length + 1;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make(`cursor-window-run-${ordinal}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          attemptId: RunAttemptId.make(`cursor-window-attempt-${ordinal}`),
          rootNodeId: NodeId.make(`cursor-window-root-${ordinal}`),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-window-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor context window",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make(`cursor-window-message-${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text: "Continue.",
            attachments: [],
          },
        });
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
        const window = runtime.getModelContextWindow?.(modelSelection);
        return {
          model: sentModels.at(-1),
          window,
          allowance: handoffBudget({
            tokenCap: DEFAULT_HANDOFF_TOKEN_CAP,
            userText: "Continue.",
            attachments: [],
            providerThread,
            nativeContextEstimate: 400_000,
            modelContextWindow: window,
          }),
        };
      });
      const beforeCatalog = yield* startTurn("1m");
      yield* Deferred.succeed(catalog, [
        {
          id: "claude-opus-5-5",
          displayName: "Claude Opus 5.5",
          parameters: [
            {
              id: "context",
              displayName: "Context",
              values: [{ value: "300k" }, { value: "1m" }],
            },
          ],
          variants: [
            {
              displayName: "Claude Opus 5.5",
              isDefault: true,
              params: [{ id: "context", value: "1m" }],
            },
          ],
        },
      ]);
      expect((yield* Fiber.join(refresh)).status).toBe("ready");
      const catalogDefault = yield* startTurn();
      const explicitWindow = yield* startTurn("500k");
      const unknownWindow = yield* startTurn("max");
      failUser = true;
      expect((yield* instance.snapshot.refresh).status).toBe("error");
      const retainedDefault = yield* startTurn();

      expect(openedModels).toEqual([
        {
          id: "claude-opus-5-5",
          params: [{ id: "context", value: "1m" }],
        },
      ]);
      expect({
        beforeCatalog,
        catalogDefault,
        explicitWindow,
        unknownWindow,
        retainedDefault,
      }).toEqual({
        beforeCatalog: {
          model: { id: "claude-opus-5-5", params: [{ id: "context", value: "1m" }] },
          window: 1_000_000,
          allowance: DEFAULT_HANDOFF_TOKEN_CAP,
        },
        catalogDefault: {
          model: { id: "claude-opus-5-5" },
          window: 1_000_000,
          allowance: DEFAULT_HANDOFF_TOKEN_CAP,
        },
        explicitWindow: {
          model: { id: "claude-opus-5-5", params: [{ id: "context", value: "500k" }] },
          window: 500_000,
          allowance: 0,
        },
        unknownWindow: {
          model: { id: "claude-opus-5-5", params: [{ id: "context", value: "max" }] },
          window: undefined,
          allowance: 0,
        },
        retainedDefault: catalogDefault,
      });
    }).pipe(Effect.scoped),
  );
});
