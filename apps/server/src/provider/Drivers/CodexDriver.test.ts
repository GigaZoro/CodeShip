import * as CodexInstallation from "../CodexInstallation.ts";
import * as CodexManagedTokenBroker from "../CodexManagedTokenBroker.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  AUTHENTICATION_FAILED_FAILURE_CODE,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { CODEX_NOT_FOUND_MESSAGE } from "../CodexProvider.ts";
import { CodexDriver } from "./CodexDriver.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import { codexAccountLimitsHomePath } from "../CodexLimitsLogin.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(PortScanner.layerTest),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(CodexInstallation.CodexInstallation)({
      managedDirectory: "unused-managed-installation",
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
      endpoint: Effect.succeed("unused-private-pipe"),
      awaitIdle: Effect.void,
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isOpenSessionError = Schema.is(ProviderAdapter.ProviderAdapterOpenSessionError);

it.layer(layerTest)("CodexDriver", (it) => {
  const checkManagedAccount = (replacementTiming: "unchanged" | "during-probe") =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("restored-managed-account");
      const credentials = new Map<string, Uint8Array>();
      const catalogTokens: Array<string> = [];
      const probeEntered = yield* Deferred.make<void>();
      const resumeProbe = yield* Deferred.make<void>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            credentials.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            credentials.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const connection = {
          clientId: "oaiapp_test",
          accessToken: "dummy-owned-access",
          refreshToken: "dummy-refresh",
          expiresAt: Number.MAX_SAFE_INTEGER,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
          subject: "test-user",
          email: "account@example.test",
        };
        const json = yield* encodeCredentials(connection);
        yield* store.set(new TextEncoder().encode(json));
        const replacement = yield* encodeCredentials({
          clientId: "oaiapp_replacement",
          subject: "replacement-user",
          email: "replacement@example.test",
          accessToken: "replacement-access",
          refreshToken: "replacement-refresh",
          expiresAt: Number.MAX_SAFE_INTEGER,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
        });
        const replaceAccount = store.set(new TextEncoder().encode(replacement)).pipe(Effect.orDie);
        const executable = {
          executablePath: "/user/bin/codex",
          managedVersionDirectory: null,
          source: "local" as const,
          version: "0.156.1",
        };
        const installation = yield* CodexInstallation.CodexInstallation;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const sharedHome = NodePath.join(serverConfig.stateDir, "shared-codex-home");
        const limitsHome = codexAccountLimitsHomePath(
          yield* Path.Path,
          serverConfig.stateDir,
          instanceId,
        );
        const launches: Array<
          Parameters<CodexAdapterV2.CodexAppServerClientFactoryShape["open"]>[0]
        > = [];

        let togglingSkills = false;
        const skillWrites: Array<unknown> = [];
        const skillHomes: Array<unknown> = [];
        let interruptedChecks = 0;
        let failAcquire = false;
        const startupChecksInterrupted = yield* Deferred.make<void>();
        const acquire = () =>
          Effect.suspend(() => {
            if (failAcquire)
              return Effect.fail(
                new CodexInstallation.CodexInstallationError({
                  operation: "acquire",
                  detail: "The fixture runtime is unavailable",
                }),
              );
            if (interruptedChecks === 2) return Effect.succeed(executable);
            interruptedChecks += 1;
            return (
              interruptedChecks === 2
                ? Deferred.succeed(startupChecksInterrupted, undefined)
                : Effect.void
            ).pipe(Effect.andThen(Effect.interrupt));
          });
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Restored account",
          enabled: true,
          environment: [{ name: "OPENAI_API_KEY", value: "ambient-key", sensitive: true }],
          config: { ...CodexDriver.defaultConfig(), setupMode: "managed", homePath: sharedHome },
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            ...process.env,
            T3CODE_CODEX_METADATA_BINARY_PATH: NodePath.join(sharedHome, "metadata-only", "codex"),
          }),
          Effect.provideService(
            CodexAdapterV2.CodexAppServerClientFactory,
            CodexAdapterV2.CodexAppServerClientFactory.of({
              open: (launch) =>
                Effect.sync(() => launches.push(launch)).pipe(
                  Effect.andThen(Effect.die("The fixture stops after recording the launch")),
                ),
            }),
          ),
          Effect.provideService(
            CodexInstallation.CodexInstallation,
            CodexInstallation.CodexInstallation.of({
              ...installation,
              managedDirectory: "unused-managed-installation",
              resolve: () => Effect.succeed(executable),
              acquire,
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.gen(function* () {
                if (
                  ChildProcess.isStandardCommand(command) &&
                  (togglingSkills || command.options.env?.CODEX_HOME === limitsHome)
                ) {
                  if (togglingSkills) skillHomes.push(command.options.env?.CODEX_HOME);
                  const responses = yield* Queue.unbounded<Uint8Array>();
                  return ChildProcessSpawner.makeHandle({
                    pid: ChildProcessSpawner.ProcessId(1),
                    exitCode: Effect.never,
                    isRunning: Effect.succeed(true),
                    kill: () => Effect.void,
                    unref: Effect.succeed(Effect.void),
                    stdin: Sink.forEach((chunk: Uint8Array) =>
                      Effect.gen(function* () {
                        const request = JSON.parse(new TextDecoder().decode(chunk)) as {
                          id?: number;
                          method: string;
                          params?: { enabled?: boolean };
                        };
                        if (request.method === "initialized") return;
                        if (request.method === "skills/config/write")
                          skillWrites.push(request.params);
                        const replies: Record<string, unknown> = {
                          initialize: {
                            userAgent: "codex/test",
                            codexHome: command.options.env?.CODEX_HOME,
                            platformFamily: "unix",
                            platformOs: "macos",
                          },
                          "account/read": {
                            account: { type: "chatgpt", email: connection.email, planType: "plus" },
                            requiresOpenaiAuth: true,
                          },
                          "account/rateLimits/read": {
                            accountId: "workspace-A",
                            rateLimits: { planType: "plus", primary: { usedPercent: 78 } },
                          },
                          "skills/config/write": { effectiveEnabled: request.params?.enabled },
                          "account/logout": {},
                        };
                        expect(Object.hasOwn(replies, request.method)).toBe(true);
                        yield* Queue.offer(
                          responses,
                          new TextEncoder().encode(
                            JSON.stringify({
                              id: request.id,
                              result: replies[request.method],
                            }) + "\n",
                          ),
                        );
                      }),
                    ),
                    stdout: Stream.fromQueue(responses),
                    stderr: Stream.empty,
                    all: Stream.empty,
                    getInputFd: () => Sink.drain,
                    getOutputFd: () => Stream.empty,
                  });
                }
                if (replacementTiming === "during-probe") {
                  yield* Deferred.succeed(probeEntered, undefined);
                  yield* Deferred.await(resumeProbe);
                }
                return yield* PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "The fixture app-server is unavailable",
                });
              }),
            ),
          ),
        );
        const observedAccount = yield* Deferred.make<void>();
        const disconnected = yield* instance.snapshot.streamChanges.pipe(
          Stream.tap((provider) =>
            provider.auth.status === "authenticated"
              ? Deferred.succeed(observedAccount, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Stream.filter((provider) => provider.auth.status === "unauthenticated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* Deferred.await(startupChecksInterrupted);
        const refresh = yield* instance.snapshot.refresh.pipe(Effect.forkChild);
        if (replacementTiming === "during-probe") {
          yield* Deferred.await(probeEntered);
          yield* replaceAccount;
          yield* Deferred.succeed(resumeProbe, undefined);
        }
        const restored = yield* Fiber.join(refresh);
        if (replacementTiming === "during-probe") {
          // Launch settings fetched Codex's catalog before the account changed; the listing never ran.
          expect(catalogTokens).toEqual(["launch:Bearer dummy-owned-access"]);
          expect(restored.models).toEqual([]);
          expect(restored.auth.email).toBe("replacement@example.test");
          expect(restored.auth.profileId).toBe("oaiapp_replacement");
          return;
        }
        expect(catalogTokens).toEqual([
          "launch:Bearer dummy-owned-access",
          "listing:Bearer dummy-owned-access",
        ]);
        expect(restored.auth.email).toBe("account@example.test");
        const workspaceToken = (id: string) =>
          `e30.${Buffer.from(JSON.stringify({ email: connection.email, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(limitsHome, { recursive: true });
        yield* fs.writeFileString(
          NodePath.join(limitsHome, "auth.json"),
          JSON.stringify({ tokens: { id_token: workspaceToken("workspace-A") } }),
        );
        let included = restored;
        for (const id of ["workspace-A", "workspace-B", undefined]) {
          const tokens = yield* encodeCredentials({
            ...connection,
            accessToken: id ? workspaceToken(id) : connection.accessToken,
          });
          yield* store.set(new TextEncoder().encode(tokens));
          const managed = yield* instance.snapshot.refresh;
          const matches = id === "workspace-A";
          expect(managed.auth.status).toBe("authenticated");
          expect(managed.auth.funding).toBe(matches ? "included" : "unknown");
          expect(managed.usageLimits?.windows.map((w) => w.usedPercent)).toEqual(
            matches ? [78] : [],
          );
          expect(
            yield* instance.fundingForWorkspace!({
              provider: managed,
              cwd: sharedHome,
              model: "gpt-5.4",
            }),
          ).toBe(matches ? "included" : "unknown");
          if (matches) included = managed;
          else {
            expect(
              yield* instance.fundingForWorkspace!({
                provider: included,
                cwd: sharedHome,
                model: "gpt-5.4",
              }),
            ).toBe("unknown");
            expect((yield* instance.consumeResetCredit!().pipe(Effect.flip)).detail).toContain(
              "could not confirm this workspace",
            );
          }
        }
        expect(restored.runtimePaths?.homePath).toBe(sharedHome);
        expect(restored.runtimePaths?.shadowHomePath).toContain(
          NodePath.join("providers", "codex", instanceId, "shadow"),
        );
        const accountHome = restored.runtimePaths!.shadowHomePath!;
        expect(instance.personalSkillsDirectory).toBe(NodePath.join(sharedHome, "skills"));
        const skillPath = NodePath.join(accountHome, "skills", "example", "SKILL.md");
        togglingSkills = true;
        for (const enabled of [false, true]) {
          yield* instance.setSkillEnabled!({ name: "example", path: skillPath, enabled });
        }
        togglingSkills = false;
        expect(skillWrites).toEqual([
          { path: skillPath, enabled: false },
          { path: skillPath, enabled: true },
        ]);
        expect(skillHomes).toEqual([accountHome, accountHome]);
        const scan = yield* instance.snapshotForCwd!(serverConfig.stateDir).pipe(Effect.exit);
        expect(Exit.isFailure(scan)).toBe(true);
        failAcquire = true;
        const runtimeScan = yield* instance.snapshotForCwd!(serverConfig.stateDir).pipe(
          Effect.exit,
        );
        failAcquire = false;
        expect(Exit.isFailure(runtimeScan)).toBe(true);
        yield* Deferred.await(observedAccount);

        const threadId = ThreadId.make("managed-account-thread");
        yield* instance.orchestrationAdapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("managed-account-session"),
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: serverConfig.stateDir,
            }),
          })
          .pipe(Effect.scoped, Effect.exit);
        expect(launches).toHaveLength(1);
        const launch = launches[0]!;
        expect(launch.settings.binaryPath).toBe(executable.executablePath);
        expect(launch.settings.launchArgs).toContain("openai_token_sharing");
        expect(launch.environment.ACCESS_TOKEN).toBeUndefined();
        expect(launch.settings.launchArgs).toContain("__managed-chatgpt-token");
        expect(launch.settings.launchArgs).not.toContain("dummy-owned-access");
        expect(launch.environment.OPENAI_API_KEY).toBeUndefined();
        expect(launch.environment.CODEX_HOME).toBe(launch.settings.homePath);
        const before = yield* instance.auth!.subscribe("test-owner").pipe(Stream.runHead);
        expect(Option.getOrThrow(before).phase).toBe("idle");
        yield* instance.auth!.logout(Effect.void);
        const after = Option.getOrThrow(yield* Fiber.join(disconnected));
        expect(after.auth.status).toBe("unauthenticated");
        expect(after.auth.email).toBeUndefined();
        expect(after.installed).toBe(true);
        expect(after.models).toEqual([]);
        expect(Option.isNone(yield* store.get)).toBe(true);
        const signedOutScan = yield* instance.snapshotForCwd!(serverConfig.stateDir);
        expect(signedOutScan.skills).toEqual([]);
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              expect([
                "https://auth.openai.com/.well-known/openid-configuration",
                "https://auth.openai.com/revoke",
                "https://api.openai.com/v1/models",
              ]).toContain(request.url);
              if (request.url.endsWith("/models")) {
                // Only the launch catalog asks as Codex, with Codex's originator header.
                const kind = request.headers.originator === undefined ? "listing" : "launch";
                catalogTokens.push(`${kind}:${request.headers.authorization}`);
                return HttpClientResponse.fromWeb(request, Response.json({ models: [] }));
              }
              return HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/revoke")
                  ? new Response(null, { status: 200 })
                  : Response.json({
                      issuer: "https://auth.openai.com",
                      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                      jwks_uri: "https://auth.openai.com/jwks",
                      revocation_endpoint: "https://auth.openai.com/revoke",
                    }),
              );
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped);
  // regression: a sign-in that replaces the account mid-probe must not label the old
  // account's catalog with the new identity.
  it.effect.each(["unchanged", "during-probe"] as const)(
    "managed catalog keeps its account label and token together: %s",
    checkManagedAccount,
  );

  const checkSharingAccount = (
    scenario:
      | "recovers"
      | "replaced"
      | "refused-after-success"
      | "refused-after-failure"
      | "restarted"
      | "sharing-disabled",
  ) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make(`sharing-${scenario}`);
      const credentials = new Map<string, Uint8Array>();
      const catalogTokens: Array<string> = [];
      let catalog: "refused" | "unavailable" | "accepted" = "refused";
      let renewals = 0;
      const renewedRequestHeld = yield* Deferred.make<void>();
      const releaseRenewedRequest = yield* Deferred.make<void>();
      const limitsReadHeld = yield* Deferred.make<void>();
      const releaseLimitsRead = yield* Deferred.make<void>();
      const secondRefusalSaved = yield* Deferred.make<void>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(credentials.get(key))),
        set: (key, value) =>
          Effect.suspend(() => {
            credentials.set(key, value);
            const saved = new TextDecoder().decode(value);
            return saved.includes('"renewed-access-2"') && saved.includes('"refused":true')
              ? Deferred.succeed(secondRefusalSaved, undefined)
              : Effect.void;
          }),
        remove: (key) =>
          Effect.sync(() => {
            credentials.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const saved = yield* encodeCredentials({
          clientId: "oaiapp_test",
          accessToken: "dummy-refused-access",
          refreshToken: "dummy-refresh",
          expiresAt: Number.MAX_SAFE_INTEGER,
          earliestRefreshAt: null,
          scopes: scenario === "sharing-disabled" ? [] : ["chatgpt.tokens.use.direct"],
          subject: "test-user",
          email: "account@example.test",
        });
        yield* store.set(new TextEncoder().encode(saved));
        const executable = {
          executablePath: "/user/bin/codex",
          managedVersionDirectory: null,
          source: "local" as const,
          version: "0.156.1",
        };
        const installation = yield* CodexInstallation.CodexInstallation;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const limitsHome = codexAccountLimitsHomePath(
          yield* Path.Path,
          serverConfig.stateDir,
          instanceId,
        );
        // Both startup checks stop before any catalog request, so each refresh below is the only
        // check that reaches ChatGPT. A sign-in without token sharing never gets that far.
        let startupChecks = scenario === "sharing-disabled" ? 0 : 2;
        const startupChecksStopped = yield* Deferred.make<void>();
        if (startupChecks === 0) yield* Deferred.succeed(startupChecksStopped, undefined);
        const acquire = () =>
          Effect.suspend(() => {
            if (startupChecks === 0) return Effect.succeed(executable);
            startupChecks -= 1;
            return (
              startupChecks === 0 ? Deferred.succeed(startupChecksStopped, undefined) : Effect.void
            ).pipe(Effect.andThen(Effect.interrupt));
          });
        const start = CodexDriver.create({
          instanceId,
          displayName: "Sharing account",
          enabled: true,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            setupMode: "managed",
            homePath: NodePath.join(serverConfig.stateDir, `${scenario}-codex-home`),
          },
        }).pipe(
          Effect.provideService(
            CodexInstallation.CodexInstallation,
            CodexInstallation.CodexInstallation.of({
              ...installation,
              managedDirectory: "unused-managed-installation",
              resolve: () => Effect.succeed(executable),
              acquire,
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.gen(function* () {
                // The first limits probe waits, as a slow one does, while a refusal lands.
                if (
                  ChildProcess.isStandardCommand(command) &&
                  command.options.env?.CODEX_HOME === limitsHome
                ) {
                  yield* Deferred.succeed(limitsReadHeld, undefined);
                  yield* Deferred.await(releaseLimitsRead);
                }
                return yield* PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "The fixture app-server is unavailable",
                });
              }),
            ),
          ),
        );
        const instance = yield* start;
        const openSession = instance.orchestrationAdapter
          .openSession({
            threadId: ThreadId.make(`${scenario}-thread`),
            providerSessionId: ProviderSessionId.make(`${scenario}-session`),
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: serverConfig.stateDir,
            }),
          })
          .pipe(Effect.scoped, Effect.flip);

        yield* Deferred.await(startupChecksStopped);

        if (scenario === "sharing-disabled") {
          const started = yield* openSession;
          // Only signing in again with token sharing fixes it, so the run moves to another account.
          expect(isOpenSessionError(started) && started.requiresSignIn).toBe(true);
          expect(makeProviderFailure({ cause: started }).code).toBe(
            AUTHENTICATION_FAILED_FAILURE_CODE,
          );
          expect(catalogTokens).toEqual([]);
          return;
        }

        const refused = yield* instance.snapshot.refresh;
        expect(catalogTokens).toEqual(["Bearer dummy-refused-access", "Bearer renewed-access-1"]);
        expect(refused.auth.status).toBe("unauthenticated");
        expect(refused.message).toBe("Your ChatGPT connection was revoked. Sign in again.");
        // The sign-in stays saved, so a refusal ChatGPT later lifts needs no new sign-in.
        expect(Option.isSome(yield* store.get)).toBe(true);

        if (scenario === "replaced") {
          const replacement = yield* encodeCredentials({
            clientId: "oaiapp_replacement",
            subject: "replacement-user",
            email: "replacement@example.test",
            accessToken: "replacement-access",
            refreshToken: "replacement-refresh",
            expiresAt: Number.MAX_SAFE_INTEGER,
            earliestRefreshAt: null,
            scopes: ["chatgpt.tokens.use.direct"],
          });
          const check = yield* instance.snapshot.refresh.pipe(Effect.forkChild);
          yield* Deferred.await(renewedRequestHeld);
          yield* store.set(new TextEncoder().encode(replacement));
          yield* Deferred.succeed(releaseRenewedRequest, undefined);
          // ChatGPT refused the replaced sign-in, not the one saved now.
          const checked = yield* Fiber.join(check);
          expect(checked.auth.status).toBe("authenticated");
          expect(checked.auth.profileId).toBe("oaiapp_replacement");
          return;
        }

        if (scenario === "refused-after-success" || scenario === "refused-after-failure") {
          catalog = "accepted";
          if (scenario === "refused-after-failure") {
            expect((yield* instance.snapshot.refresh).auth.status).toBe("authenticated");
            catalog = "unavailable";
          }
          // A made-up Codex login, so the check also reads this account's limits through it.
          const claims = {
            email: "account@example.test",
            "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
          };
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.makeDirectory(limitsHome, { recursive: true });
          yield* fileSystem.writeFileString(
            NodePath.join(limitsHome, "auth.json"),
            JSON.stringify({
              tokens: {
                id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`,
              },
            }),
          );
          const check = yield* instance.snapshot.refresh.pipe(Effect.forkChild);
          yield* Deferred.await(limitsReadHeld);
          // A run starting meanwhile renews the token, and ChatGPT refuses the renewed one too.
          catalog = "refused";
          const started = yield* openSession.pipe(Effect.forkChild);
          yield* Deferred.await(secondRefusalSaved);
          yield* Deferred.succeed(releaseLimitsRead, undefined);
          // What the check saw before its limits loaded says nothing about the refused sign-in.
          const checked = yield* Fiber.join(check);
          expect(checked.auth.status).toBe("unauthenticated");
          expect(checked.message).toBe("Your ChatGPT connection was revoked. Sign in again.");
          expect(isOpenSessionError(yield* Fiber.join(started))).toBe(true);
          return;
        }

        // A failure that is not a refusal keeps the account signed out until its token works again.
        catalog = "unavailable";
        if (scenario === "restarted") {
          // A new secret store service shares nothing in memory with the first server, as after a restart.
          const restarted = yield* start.pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, { ...secrets }),
          );
          expect((yield* restarted.snapshot.refresh).auth.status).toBe("unauthenticated");
          return;
        }
        expect((yield* instance.snapshot.refresh).auth.status).toBe("unauthenticated");
        catalog = "accepted";
        expect((yield* instance.snapshot.refresh).auth.status).toBe("authenticated");
        catalog = "unavailable";
        const recovered = yield* instance.snapshot.refresh;
        expect(recovered.auth.status).toBe("authenticated");
        expect(recovered.message).toBe(
          "Could not check Codex right now. Retry, or reconnect in provider settings.",
        );
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              if (request.url.endsWith("/v1/models")) {
                const token = request.headers.authorization ?? "";
                catalogTokens.push(token);
                if (scenario === "replaced" && token === "Bearer renewed-access-2") {
                  yield* Deferred.succeed(renewedRequestHeld, undefined);
                  yield* Deferred.await(releaseRenewedRequest);
                }
                return HttpClientResponse.fromWeb(
                  request,
                  catalog === "accepted"
                    ? Response.json({ models: [] })
                    : Response.json(
                        {
                          error: { code: catalog === "refused" ? "token_revoked" : "unavailable" },
                        },
                        { status: catalog === "refused" ? 401 : 503 },
                      ),
                );
              }
              if (request.url.endsWith("/oauth/token")) {
                renewals += 1;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    access_token: `renewed-access-${renewals}`,
                    refresh_token: `renewed-refresh-${renewals}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "chatgpt.tokens.use.direct",
                  }),
                );
              }
              expect(request.url).toBe("https://auth.openai.com/.well-known/openid-configuration");
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  issuer: "https://auth.openai.com",
                  authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
                  token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
                  jwks_uri: "https://auth.openai.com/jwks",
                  revocation_endpoint: "https://auth.openai.com/revoke",
                }),
              );
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped);
  // regression: a token ChatGPT refused even after renewal, a refusal saved while a check read
  // its limits, or a sign-in without token sharing kept the account signed in, so Auto kept
  // choosing an account that could not run.
  it.effect.each([
    "recovers",
    "replaced",
    "refused-after-success",
    "refused-after-failure",
    "restarted",
    "sharing-disabled",
  ] as const)("shows a ChatGPT connection that cannot run as signed out: %s", checkSharingAccount);

  // regression: an existing-CLI account with the default path reported "Not found" on a machine
  // with no `codex` on PATH, although T3.CodeShip had a copy of its own.
  it.effect.each([
    { name: "own copy", onPath: false, ownCopy: true, explicit: false },
    { name: "codex on PATH", onPath: true, ownCopy: true, explicit: false },
    { name: "nothing installed", onPath: false, ownCopy: false, explicit: false },
    { name: "explicit path", onPath: true, ownCopy: true, explicit: true },
  ])(
    "starts the default binary path from PATH, else from T3.CodeShip's own copy: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-default-binary-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const pathDir = NodePath.join(tempDir, "bin");
        yield* fs.makeDirectory(pathDir, { recursive: true });
        if (fixture.onPath) {
          yield* fs.writeFileString(NodePath.join(pathDir, "codex"), "#!/bin/sh\n");
          yield* fs.chmod(NodePath.join(pathDir, "codex"), 0o755);
        }
        const ownCopyPath = NodePath.join(tempDir, "tools", "codex", "0.156.1", "bin", "codex");
        const explicitPath = NodePath.join(tempDir, "missing", "codex");
        const expected = fixture.explicit ? explicitPath : fixture.onPath ? "codex" : ownCopyPath;
        const ownCopy = () =>
          fixture.explicit || fixture.onPath
            ? Effect.die("A Codex on PATH or an explicit path must not use T3.CodeShip's copy")
            : fixture.ownCopy
              ? Effect.succeed({
                  executablePath: ownCopyPath,
                  managedVersionDirectory: NodePath.dirname(NodePath.dirname(ownCopyPath)),
                  source: "managed" as const,
                  version: "0.156.1",
                })
              : Effect.fail(
                  new CodexInstallation.CodexInstallationError({
                    operation: "resolve",
                    detail: "Codex is not installed in T3.CodeShip.",
                  }),
                );
        const spawned: Array<string> = [];
        const launches: Array<string> = [];
        const instanceId = ProviderInstanceId.make("codex-default-binary");
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Codex default binary",
          enabled: true,
          environment: [{ name: "PATH", value: pathDir, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            setupMode: "existing",
            homePath: NodePath.join(tempDir, "codex-home"),
            shadowHomePath: NodePath.join(tempDir, "codex-shadow"),
            ...(fixture.explicit ? { binaryPath: explicitPath } : {}),
          },
        }).pipe(
          Effect.provideService(HostProcess.Environment, {
            ...process.env,
            T3CODE_CODEX_METADATA_BINARY_PATH: NodePath.join(tempDir, "metadata-only", "codex"),
          }),
          Effect.provideService(
            CodexAdapterV2.CodexAppServerClientFactory,
            CodexAdapterV2.CodexAppServerClientFactory.of({
              open: (launch) =>
                Effect.sync(() => launches.push(launch.settings.binaryPath)).pipe(
                  Effect.andThen(Effect.die("The fixture stops after recording the launch")),
                ),
            }),
          ),
          Effect.provideService(
            CodexInstallation.CodexInstallation,
            CodexInstallation.CodexInstallation.of({
              ...(yield* CodexInstallation.CodexInstallation),
              resolve: ownCopy,
              acquire: ownCopy,
            }),
          ),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.gen(function* () {
                if (ChildProcess.isStandardCommand(command)) spawned.push(command.command);
                return yield* PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "The fixture cannot start a process",
                });
              }),
            ),
          ),
        );

        const status = yield* instance.snapshot.refresh;
        expect(status.installed).toBe(false);
        expect(status.setup?.canInstall).toBe(!fixture.explicit);
        yield* instance.orchestrationAdapter
          .openSession({
            threadId: ThreadId.make("default-binary-thread"),
            providerSessionId: ProviderSessionId.make("default-binary-session"),
            modelSelection: { instanceId, model: "gpt-5.4" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: tempDir,
            }),
          })
          .pipe(Effect.scoped, Effect.exit);
        // Sign-out opens the app server the same way sign-in does.
        yield* instance.auth!.logout(Effect.void).pipe(Effect.exit);

        if (!fixture.onPath && !fixture.ownCopy) {
          expect(status.message).toBe(CODEX_NOT_FOUND_MESSAGE);
          expect(spawned).toEqual([]);
          expect(launches).toEqual([]);
          return;
        }
        expect(status.message).toContain(`Could not start Codex CLI (\`${expected}\`)`);
        expect(new Set(spawned)).toEqual(new Set([expected]));
        expect(spawned.length).toBeGreaterThan(1);
        expect(launches).toEqual([expected]);
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );

  it.effect.skipIf(windowsHost)(
    "runs the standalone updater and installs skills in the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const shadowHome = NodePath.join(tempDir, "codex-shadow");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-shadow"),
          displayName: "Codex test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
        expect(instance.personalSkillsDirectory).toBe(NodePath.join(sharedHome, "skills"));
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the home that holds a shared install",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        // One standalone install, linked onto PATH and used by two account homes.
        // `İ` gets longer when lowercased, so the home must not be sliced from a
        // lowercased copy of the path.
        const installHome = NodePath.join(tempDir, "codex-İnstall");
        const realBinaryPath = NodePath.join(
          installHome,
          "packages",
          "standalone",
          "releases",
          "0.162.1-x86_64-unknown-linux-musl",
          "bin",
          "codex",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const updates = yield* Effect.forEach(["codex-p", "codex-vm"], (account) =>
          Effect.gen(function* () {
            const homePath = NodePath.join(tempDir, `home-${account}`);
            yield* fs.makeDirectory(homePath, { recursive: true });
            const instance = yield* CodexDriver.create({
              instanceId: ProviderInstanceId.make(account),
              displayName: account,
              enabled: false,
              environment: [],
              config: { ...CodexDriver.defaultConfig(), binaryPath, homePath },
            });
            return (yield* instance.snapshot.resolveMaintenance()).update;
          }),
        );

        for (const update of updates) {
          expect(update).toMatchObject({
            command: `${binaryPath} update`,
            args: ["update"],
            lockKey: "codex-native",
            env: { CODEX_HOME: installHome },
          });
        }
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );

  it.effect.skipIf(windowsHost)("derives the standalone update home from either command path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-codex-update-home-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const linkedInstallHome = NodePath.join(tempDir, "install");
      const fixtures = [
        { binary: "codex", realPath: "/packages/standalone/bin/codex", home: "/" },
        { binary: "codex", realPath: "C:\\Packages\\Standalone\\bin\\codex.exe", home: "C:\\" },
        // The standalone tree itself is a symlink, so only the resolved path names its home.
        {
          binary: NodePath.join("install", "packages", "standalone", "bin", "codex"),
          realPath: "/disk/codex/releases/0.163.0/bin/codex",
          home: linkedInstallHome,
        },
      ];

      for (const fixture of fixtures) {
        const binaryPath = NodePath.join(tempDir, fixture.binary);
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-update-home"),
          displayName: "Codex update home",
          enabled: false,
          environment: [],
          config: { ...CodexDriver.defaultConfig(), binaryPath, homePath: tempDir },
        }).pipe(
          // Virtualize only the executable target: these trees do not belong to this test.
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            realPath: (path) =>
              path === binaryPath ? Effect.succeed(fixture.realPath) : fs.realPath(path),
          }),
        );
        expect((yield* instance.snapshot.resolveMaintenance()).update?.env).toEqual({
          CODEX_HOME: fixture.home,
        });
      }
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );

  // regression: #23937 `codex update` installs the native channel's release, which can lag npm.
  it.effect.skipIf(windowsHost)(
    "does not advertise npm's latest Codex to a standalone install",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const home = NodePath.join(tempDir, "codex-home");
        const binaryPath = NodePath.join(home, "packages", "standalone", "current", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);
        // npm's latest tag is ahead of the native channel, as during a staggered release.
        const npmView = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "view") {
            return Effect.die("Version lookup must not run a provider or updater");
          }
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make('"0.164.0"')),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-standalone-latest"),
          displayName: "Codex standalone",
          enabled: false,
          environment: [],
          config: { ...CodexDriver.defaultConfig(), binaryPath, homePath: home },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, npmView),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === "https://releases.openai.com/codex/channels/latest"
                    ? Response.json({ tag_name: "rust-v0.163.0", assets: [] })
                    : new Response(null, { status: 404 }),
                ),
              ),
            ),
          ),
        );
        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update?.lockKey).toBe("codex-native");

        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make(),
          ),
        );
        expect(latestVersion).toBe("0.163.0");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: "0.163.0",
            latestVersion,
            maintenanceCapabilities: capabilities,
          }).status,
        ).not.toBe("behind_latest");
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );

  it.effect("uses each instance's environment CODEX_HOME for continuation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });
      for (const [index, account] of ["work", "personal", "work "].entries()) {
        const codexHome = NodePath.join(tempDir, account);
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`account-${index}`),
          displayName: account,
          enabled: false,
          environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
          config: CodexDriver.defaultConfig(),
        });
        expect(instance.continuationIdentity.continuationKey).toBe(`codex:home:${codexHome}`);
      }
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );

  it.effect.skipIf(windowsHost)(
    "shares state from the environment CODEX_HOME in a shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const codexHome = NodePath.join(tempDir, "custom-codex");
        const shadowHome = NodePath.join(tempDir, "shadow");
        yield* fs.makeDirectory(codexHome, { recursive: true });
        yield* fs.writeFileString(NodePath.join(codexHome, "config.toml"), 'model = "custom"\n');
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("env-shadow"),
          displayName: "env-shadow",
          enabled: false,
          environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
          config: { ...CodexDriver.defaultConfig(), shadowHomePath: shadowHome },
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, NodePath.join(tempDir, "user")));
        expect(instance.continuationIdentity.continuationKey).toBe(`codex:home:${codexHome}`);
        expect(yield* fs.readLink(NodePath.join(shadowHome, "config.toml"))).toBe(
          NodePath.join(codexHome, "config.toml"),
        );
        expect(yield* fs.readLink(NodePath.join(shadowHome, "sessions"))).toBe(
          NodePath.join(codexHome, "sessions"),
        );
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
  );

  it.effect(
    "gives an added or private-login account its own auth folder unless a home is set",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });
        const launchHomes = new Map<string, string>();
        const create = Effect.fn(function* (
          id: string,
          config: Partial<ReturnType<typeof CodexDriver.defaultConfig>> = {},
          environment: ReadonlyArray<{ name: string; value: string; sensitive: false }> = [],
        ) {
          const instanceId = ProviderInstanceId.make(id);
          const instance = yield* CodexDriver.create({
            instanceId,
            displayName: id,
            enabled: false,
            environment: [...environment],
            config: {
              ...CodexDriver.defaultConfig(),
              binaryPath: NodePath.join(tempDir, "codex"),
              ...config,
            },
          }).pipe(
            Effect.provideService(
              CodexAdapterV2.CodexAppServerClientFactory,
              CodexAdapterV2.CodexAppServerClientFactory.of({
                open: (launch) =>
                  Effect.sync(() => launchHomes.set(id, launch.settings.homePath)).pipe(
                    Effect.andThen(Effect.die("The fixture stops after recording the launch")),
                  ),
              }),
            ),
          );
          yield* instance.orchestrationAdapter
            .openSession({
              threadId: ThreadId.make(`${id}-thread`),
              providerSessionId: ProviderSessionId.make(`${id}-session`),
              modelSelection: { instanceId, model: "gpt-5.4" },
              runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: tempDir,
              }),
            })
            .pipe(Effect.scoped, Effect.exit);
        });
        const shadow = (id: string) => NodePath.join(stateDir, "providers", "codex", id, "shadow");

        yield* create("codex-added");
        yield* create("codex");
        yield* create("codex-own-home", { homePath: NodePath.join(tempDir, "own") });
        yield* create("codex-env-home", {}, [
          { name: "CODEX_HOME", value: NodePath.join(tempDir, "env"), sensitive: false },
        ]);

        expect(yield* fs.exists(shadow("codex-added"))).toBe(true);
        for (const id of ["codex", "codex-own-home", "codex-env-home"]) {
          expect(yield* fs.exists(shadow(id))).toBe(false);
        }

        yield* create("codex", { privateLogin: true });
        expect(yield* fs.exists(shadow("codex"))).toBe(true);

        // regression: the chat session read the stored config, so an added account's turns ran
        // under the default Codex login in the shared home.
        expect(launchHomes.get("codex-added")).toBe(shadow("codex-added"));
        expect(launchHomes.get("codex")).toBe(shadow("codex"));
        expect(launchHomes.get("codex-own-home")).toBe(NodePath.join(tempDir, "own"));
        expect(launchHomes.get("codex-env-home")).toBe(NodePath.join(tempDir, "env"));
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-installer-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-installer"),
          displayName: "Codex installer test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn)),
    );
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmPath = NodePath.join(npmBin, "npm");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmPath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          const isNpmOutdated =
            ChildProcess.isStandardCommand(command) &&
            command.command === npmPath &&
            command.args[0] === "outdated";
          if (
            !ChildProcess.isStandardCommand(command) ||
            (command.command !== brewPath && !isNpmOutdated)
          ) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          if (!isNpmOutdated) probes.push(command.args.map(String));
          const stdout = isNpmOutdated
            ? JSON.stringify({ "@openai/codex": { latest: "0.153.4" } })
            : command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-mise-shim"),
          displayName: "Codex shim test",
          enabled: false,
          environment: [{ name: "PATH", value: lookupPath, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: fixture.commandName,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, metadataSpawner));
        const capabilities = yield* instance.snapshot
          .resolveMaintenance()
          .pipe(Effect.provideService(HostProcess.Environment, { PATH: "" }));
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@openai/codex", "0.153.4"]]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining([
              "--prefix",
              yield* fs.realPath(npmPrefix),
              "@openai/codex@latest",
            ]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }),
    { skip: windowsHost },
  );

  it.effect("probes again when auth.json in the Codex home changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-auth-watch-" });
      const watchedPath = yield* Deferred.make<string>();
      const homeEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const probes = yield* Queue.unbounded<void>();
      yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-auth-watch"),
        displayName: "Codex auth watch",
        enabled: true,
        environment: [],
        config: { ...CodexDriver.defaultConfig(), homePath: codexHome },
      }).pipe(
        // OS watchers can miss events written right after they start, so the test supplies them.
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: (path) =>
            Stream.unwrap(
              Deferred.succeed(watchedPath, path).pipe(Effect.as(Stream.fromQueue(homeEvents))),
            ),
        }),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            (ChildProcess.isStandardCommand(command) && command.args.includes("app-server")
              ? Queue.offer(probes, undefined)
              : Effect.void
            ).pipe(
              Effect.andThen(
                PlatformError.badArgument({
                  module: "ChildProcessSpawner",
                  method: "spawn",
                  description: "The fixture has no Codex executable",
                }),
              ),
            ),
          ),
        ),
      );
      expect(yield* Deferred.await(watchedPath)).toBe(codexHome);
      yield* Queue.take(probes);

      yield* Queue.offer(homeEvents, { _tag: "Update", path: "auth.json" });
      yield* TestClock.adjust("250 millis");

      yield* Queue.take(probes);
    }),
  );
});
