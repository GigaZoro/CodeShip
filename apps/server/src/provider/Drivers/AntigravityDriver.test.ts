import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts/baseSchemas";
import { ANTIGRAVITY_DEFAULT_MODEL } from "@t3tools/contracts/model";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { AntigravitySettings } from "@t3tools/contracts/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { markWindowsJobSpawner } from "@t3tools/shared/windowsJobSpawner";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityInstanceDirectories,
} from "../antigravityAuthSupport.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "../ModelManifest.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const blockedCredentialKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: {
    readonly config?: Partial<AntigravitySettings>;
    readonly enabled?: boolean;
    readonly source?: AntigravityInstallation.AntigravityExecutable["source"];
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const baseEnv = yield* HostProcess.Environment;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-driver-" });
  const userHome = path.join(root, "user");
  const userConfigDirectory = path.join(userHome, ".gemini", "config");
  yield* fs.makeDirectory(userConfigDirectory, { recursive: true });
  const userMcpConfig = path.join(userConfigDirectory, "mcp_config.json");
  yield* fs.writeFileString(userMcpConfig, JSON.stringify({ mcpServers: {} }));
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
  const profileDirectory = directories.profile;
  const instancePath = `${path.join(root, "instance-bin")}:${baseEnv.PATH ?? ""}`;

  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    loginRequired = false,
  ) {
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy_acp_server.par");
    const harnessPath = path.join(directory, "localharness_external");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        ...(loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(harnessPath, "#!/bin/sh\nexit 99\n");
    yield* fs.chmod(executablePath, 0o755);
    yield* fs.chmod(harnessPath, 0o755);
    return {
      executablePath,
      harnessPath,
      source: "managed",
      version: name,
      managedVersionDirectory: directory,
    } satisfies AntigravityInstallation.AntigravityExecutable;
  });

  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", true);
  const controls = {
    selected: first,
    failResolution: false,
    beforeAcquire: Effect.void,
  };
  const installedUpdates: string[] = [];
  const acquisitions: Array<{ binaryPath: string | undefined; path: string | undefined }> = [];
  const releases: Array<string | null> = [];
  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    profileDirectory: string | undefined;
    harnessPath: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    geminiApiKey: string | undefined;
    tempDirectory: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const layerInstallation = Layer.mock(AntigravityInstallation.AntigravityInstallation)({
    managedDirectory: root,
    latestVersion: Effect.succeed("1.5.3"),
    upgrade: (version) => Effect.sync(() => void installedUpdates.push(version)),
    withQuotaProbePermit: (effect) => effect,
    resolve: () =>
      Effect.gen(function* () {
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        return {
          ...controls.selected,
          source: options.source ?? controls.selected.source,
        };
      }),
    acquire: (binaryPath, environment) =>
      Effect.gen(function* () {
        acquisitions.push({ binaryPath, path: environment?.PATH });
        yield* controls.beforeAcquire;
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        const selected = controls.selected;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(selected.version);
          }),
        );
        return selected;
      }),
  });
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const handle = yield* spawner.spawn(command);
      const environment = command.options.env ?? {};
      launches.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        profileDirectory: environment.GEMINI_HOME,
        harnessPath: environment.ANTIGRAVITY_HARNESS_PATH,
        forceFileStorage: environment.AGY_ACP_FORCE_FILE_STORAGE,
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        geminiApiKey: environment.GEMINI_API_KEY,
        tempDirectory:
          environment.ANTIGRAVITY_HARNESS_PATH === undefined ? undefined : environment.TMPDIR,
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? true,
    config: { ...AntigravityDriver.defaultConfig(), ...options.config },
    environment: [
      { name: "HOME", value: userHome },
      { name: "USERPROFILE", value: userHome },
      { name: "PATH", value: instancePath },
      { name: "T3_ACP_ANTIGRAVITY", value: "1" },
      { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GEMINI_API_KEY", value: "must-not-be-used" },
      { name: "google_api_key", value: "must-not-be-used" },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-be-used.json" },
      { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
      { name: "GEMINI_HOME", value: "/must-not-be-used" },
      { name: "ANTIGRAVITY_HARNESS_PATH", value: "/must-not-be-used" },
      { name: "BROWSER", value: "must-not-run" },
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(layerInstallation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
  );
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
      if (launch.tempDirectory) expect(yield* fs.exists(launch.tempDirectory)).toBe(false);
    }
  });
  return {
    instance,
    refresh,
    fs,
    path,
    profileDirectory,
    userMcpConfig,
    directories,
    instancePath,
    first,
    second,
    signedOut,
    controls,
    acquisitions,
    releases,
    launches,
    readRequests,
    assertClosed,
    installedUpdates,
  };
});

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected provider update request")),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
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
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);

it.layer(layerTest)("AntigravityDriver", (it) => {
  it.effect.each(["managed", "path", "override"] as const)(
    "only updates an existing managed runtime when the executable source is %s",
    (source) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          source,
          ...(source === "override" ? { config: { binaryPath: "custom-antigravity" } } : {}),
        });
        const maintenance = yield* h.instance.snapshot.resolveMaintenance();
        if (source === "managed") {
          expect(maintenance.lookupLatestVersion).toBeDefined();
          expect(maintenance.builtInUpdate).toBeDefined();
          yield* maintenance.builtInUpdate!.run("1.5.3");
          expect(h.installedUpdates).toEqual(["1.5.3"]);
        } else {
          expect(maintenance.builtInUpdate).toBeUndefined();
          expect(h.installedUpdates).toEqual([]);
        }
      }),
  );

  it.effect.skipIf(windowsHost)(
    "refreshes through the selected executable and personal Google ACP",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        expect(
          yield* h.fs.realPath(h.path.join(h.profileDirectory, "config", "mcp_config.json")),
        ).toBe(yield* h.fs.realPath(h.userMcpConfig));
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        expect(snapshot.models.every((model) => model.isLegacy !== true)).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        h.controls.selected = h.second;
        yield* h.refresh();

        expect(h.acquisitions).toEqual([
          { binaryPath: "", path: h.instancePath },
          { binaryPath: "", path: h.instancePath },
        ]);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.command)).toEqual([
          h.first.executablePath,
          h.second.executablePath,
        ]);
        expect(nativeLaunches.map((launch) => launch.harnessPath)).toEqual([
          h.first.harnessPath,
          h.second.harnessPath,
        ]);
        for (const launch of nativeLaunches) {
          expect(launch.args).toEqual(hostPlatform === "linux" ? ["--uid="] : []);
          expect(launch.profileDirectory).toBe(h.profileDirectory);
          expect(launch.forceFileStorage).toBe("1");
          expect(launch.extendEnv).toBe(false);
        }
        for (const launch of h.launches) expect(launch.credentialKeys).toEqual([]);
        expect(h.releases).toEqual([h.first.version, h.second.version]);
        const requests = yield* h.readRequests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "auth/login",
          "session/new",
          "session/set_config_option",
          "session/set_config_option",
          "initialize",
          "auth/login",
          "session/new",
          "session/set_config_option",
          "session/set_config_option",
        ]);
        expect(
          requests
            .filter((request) => request.method === "session/set_config_option")
            .map((request) => request.params?.value),
        ).toEqual(["gemini-test-high", "gemini-test-low", "gemini-test-high", "gemini-test-low"]);
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["oauth-personal", "oauth-personal"]);
        expect(
          requests
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.acquisitions).toHaveLength(2);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when executable resolution fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      h.controls.failResolution = true;
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      const after = yield* h.instance.snapshot.getSnapshot;
      expect(after.models).toEqual(before.models);
      expect(after.auth).toEqual(before.auth);
      expect(h.acquisitions).toHaveLength(2);
      expect(h.releases).toEqual([h.first.version]);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "removes runtime temp directories left by a previous server on create",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const instanceId = ProviderInstanceId.make("antigravity-orphan-sweep");
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        const legacyRoot = path.join(directories.profile, "antigravity-acp", "tmp");
        for (const root of [directories.runtimeTemp, legacyRoot]) {
          const orphan = path.join(root, "run-orphan", "_MEI123", "google3");
          yield* fs.makeDirectory(orphan, { recursive: true });
          yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
        }
        yield* AntigravityDriver.create({
          instanceId,
          displayName: "Sweep",
          enabled: false,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        }).pipe(
          Effect.provide(
            Layer.mock(AntigravityInstallation.AntigravityInstallation)({
              managedDirectory: config.stateDir,
              resolve: () => Effect.die("unused"),
              acquire: () => Effect.die("unused"),
            }),
          ),
        );
        expect(yield* fs.exists(directories.runtimeTemp)).toBe(false);
        expect(yield* fs.exists(legacyRoot)).toBe(false);
      }).pipe(Effect.scoped),
  );

  const QUOTA_REPORT_152 = [
    "### Quota Limits",
    "- **Gemini Models**",
    "  - **Five Hour Limit Remaining:** 80% remaining",
    "  - **Weekly Limit Remaining:** 90% remaining",
  ].join("\n");

  const makeManagedAntigravityInstallation = Effect.fn("makeManagedAntigravityInstallation")(
    function* (baseDir: string) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const arch = yield* HostProcess.Architecture;
      const releaseId = "a".repeat(64);
      const managedDir = path.join(baseDir, "tools", "antigravity-acp", `${platform}-${arch}`);
      const versionDir = path.join(managedDir, "versions", releaseId);
      const executableName = platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
      const harnessName =
        platform === "win32" ? "localharness_external.exe" : "localharness_external";
      yield* fs.makeDirectory(versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(versionDir, executableName), "stub");
      yield* fs.writeFileString(path.join(versionDir, harnessName), "stub");
      if (platform !== "win32") {
        yield* fs.chmod(path.join(versionDir, executableName), 0o755);
        yield* fs.chmod(path.join(versionDir, harnessName), 0o755);
      }
      yield* fs.writeFileString(
        path.join(versionDir, ".install-complete.json"),
        JSON.stringify({
          releaseId,
          version: "1.5.2",
          executable: { name: executableName, bytes: 4 },
          harness: { name: harnessName, bytes: 4 },
        }),
      );
      yield* fs.writeFileString(
        path.join(managedDir, "active.json"),
        JSON.stringify({ releaseId }),
      );
      return yield* AntigravityInstallation.makeAntigravityInstallation({ baseDir });
    },
  );

  const makeQuotaSpawner = (
    onQuotaLaunch: (context: { readonly attempt: number }) => {
      readonly beforeInitialize?: Effect.Effect<void>;
      readonly report?: string;
    },
  ) => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let attempts = 0;
    let active = 0;
    let maxConcurrent = 0;
    const spawner = markWindowsJobSpawner(
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") {
            return yield* Effect.die("Unexpected command");
          }
          if (command.args[0] === "-e") {
            const preflight = `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"https://example.invalid/t3-antigravity-browser-preflight"\n`;
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(100),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.make(encoder.encode(preflight)),
              all: Stream.make(encoder.encode(preflight)),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }
          attempts++;
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
          const behavior = onQuotaLaunch({ attempt: attempts });
          const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const scope = yield* Effect.scope;
          let released = false;
          const release = Effect.sync(() => {
            if (released) return;
            released = true;
            active--;
          });
          yield* Effect.addFinalizer(() =>
            release.pipe(
              Effect.andThen(Queue.end(stdout).pipe(Effect.ignore)),
              Effect.andThen(
                Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.ignore),
              ),
            ),
          );
          const send = (payload: unknown) =>
            Queue.offer(stdout, encoder.encode(`${JSON.stringify(payload)}\n`)).pipe(Effect.asVoid);
          let buffer = "";
          const handleMessage = (rawLine: string) =>
            Effect.gen(function* () {
              const message = JSON.parse(rawLine) as {
                readonly id?: number;
                readonly method?: string;
              };
              if (message.method === "initialize") {
                if (behavior.beforeInitialize) yield* behavior.beforeInitialize;
                yield* send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: 1,
                    agentInfo: { name: "antigravity-acp", version: "1.5.2" },
                    agentCapabilities: {
                      loadSession: true,
                      sessionCapabilities: { resume: {} },
                      auth: { logout: {} },
                    },
                    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
                  },
                });
              } else if (
                message.method === "authenticate" ||
                message.method === "auth/login" ||
                message.method === "logout"
              ) {
                yield* send({ jsonrpc: "2.0", id: message.id, result: {} });
              } else if (message.method === "session/new") {
                yield* send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { sessionId: "quota-session" },
                });
                yield* send({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "quota-session",
                    update: {
                      sessionUpdate: "available_commands_update",
                      availableCommands: [{ name: "usage", description: "Usage" }],
                    },
                  },
                });
              } else if (message.method === "session/prompt") {
                yield* send({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "quota-session",
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: behavior.report ?? QUOTA_REPORT_152 },
                    },
                  },
                });
                yield* send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { stopReason: "end_turn" },
                });
              }
            });
          const stdin = Sink.forEach<Uint8Array, void, never, never>((chunk) =>
            Effect.gen(function* () {
              buffer += decoder.decode(chunk, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                yield* handleMessage(trimmed).pipe(Effect.ignore, Effect.forkIn(scope));
              }
            }),
          );
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(200 + attempts),
            exitCode: Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () =>
              release.pipe(
                Effect.andThen(Queue.end(stdout).pipe(Effect.ignore)),
                Effect.andThen(
                  Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.ignore),
                ),
              ),
            stdin,
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          });
        }),
      ),
    );
    return {
      spawner,
      getAttempts: () => attempts,
      getMaxConcurrent: () => maxConcurrent,
    };
  };

  const writeTokenFile = Effect.fn("writeAntigravityTokenFile")(function* (
    instanceId: ProviderInstanceId,
    refreshToken: string,
    fileName = "acp_token.json",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
    const acpDir = path.join(directories.profile, "antigravity-acp");
    yield* fs.makeDirectory(acpDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(acpDir, fileName),
      JSON.stringify({
        client_id: "google-client-id",
        client_secret: "google-client-secret",
        refresh_token: refreshToken,
      }),
    );
  });

  const makeGoogleIdentityHttpClient = (input: {
    readonly userIdByRefreshToken?: Readonly<Record<string, string>>;
    readonly shouldFailUserInfo?: () => boolean;
  }) => {
    let tokenCalls = 0;
    let userInfoCalls = 0;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url === "https://oauth2.googleapis.com/token") {
          tokenCalls++;
          const body =
            request.body._tag === "Uint8Array"
              ? new URLSearchParams(new TextDecoder().decode(request.body.body))
              : new URLSearchParams();
          const refreshToken = body.get("refresh_token") ?? "";
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({ access_token: `access:${refreshToken}`, expires_in: 3600 }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        if (request.url === "https://www.googleapis.com/oauth2/v2/userinfo") {
          userInfoCalls++;
          if (input.shouldFailUserInfo?.()) {
            return HttpClientResponse.fromWeb(
              request,
              new Response("unavailable", { status: 503 }),
            );
          }
          const auth = request.headers.authorization ?? "";
          const refreshToken = auth.replace(/^Bearer access:/, "");
          const id = input.userIdByRefreshToken?.[refreshToken] ?? "google-user-default";
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ id }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return yield* Effect.die(`Unexpected HTTP request: ${request.url}`);
      }),
    );
    return {
      client,
      getTokenCalls: () => tokenCalls,
      getUserInfoCalls: () => userInfoCalls,
    };
  };

  it.effect(
    "does not cache timed-out quota probes and retries immediately on the next refresh",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-retry-" });
        const installation = yield* makeManagedAntigravityInstallation(baseDir);
        const attempt1Started = yield* Deferred.make<void>();
        const fake = makeQuotaSpawner(({ attempt }) => ({
          beforeInitialize:
            attempt === 1
              ? Deferred.succeed(attempt1Started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
        }));
        const google = makeGoogleIdentityHttpClient({});
        const instanceId = ProviderInstanceId.make("agy-retry-test");
        yield* writeTokenFile(instanceId, "refresh-retry");
        const instance = yield* AntigravityDriver.create({
          instanceId,
          displayName: "Retry account",
          enabled: true,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        }).pipe(
          Effect.provideService(AntigravityInstallation.AntigravityInstallation, installation),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
          Effect.provideService(HttpClient.HttpClient, google.client),
        );

        const firstRefresh = yield* instance.snapshot.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(attempt1Started);
        yield* TestClock.adjust("91 seconds");
        yield* Fiber.join(firstRefresh);

        const failedSnapshot = yield* instance.snapshot.getSnapshot;
        expect(failedSnapshot.usageLimits?.unavailable?.reason).toBe("probeFailed");
        expect(fake.getAttempts()).toBe(1);

        // Immediate retry succeeds without waiting for the 5-minute TTL.
        yield* instance.snapshot.refreshUsage!;
        const recoveredSnapshot = yield* instance.snapshot.getSnapshot;
        expect(recoveredSnapshot.usageLimits?.unavailable).toBeUndefined();
        expect(recoveredSnapshot.usageLimits?.windows.length).toBeGreaterThan(0);
        expect(fake.getAttempts()).toBe(2);

        // Subsequent refresh within 5 minutes reuses the cached successful reading.
        yield* instance.snapshot.refreshUsage!;
        expect(fake.getAttempts()).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "serializes quota probes across drivers and gives a queued 50s probe its full 90s timeout budget",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-serial-" });
        const installation = yield* makeManagedAntigravityInstallation(baseDir);
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const fake = makeQuotaSpawner(({ attempt }) => ({
          beforeInitialize: (attempt === 1
            ? Deferred.succeed(firstStarted, undefined)
            : Deferred.succeed(secondStarted, undefined)
          ).pipe(Effect.andThen(Effect.sleep("50 seconds"))),
        }));
        const google = makeGoogleIdentityHttpClient({});
        const firstId = ProviderInstanceId.make("agy-serial-1");
        const secondId = ProviderInstanceId.make("agy-serial-2");
        yield* writeTokenFile(firstId, "refresh-serial-1");
        yield* writeTokenFile(secondId, "refresh-serial-2");

        const createDriver = (instanceId: ProviderInstanceId, displayName: string) =>
          AntigravityDriver.create({
            instanceId,
            displayName,
            enabled: true,
            config: AntigravityDriver.defaultConfig(),
            environment: [],
          }).pipe(
            Effect.provideService(AntigravityInstallation.AntigravityInstallation, installation),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
            Effect.provideService(HttpClient.HttpClient, google.client),
          );

        const firstDriver = yield* createDriver(firstId, "Account 1");
        const secondDriver = yield* createDriver(secondId, "Account 2");

        const firstFiber = yield* firstDriver.snapshot.refreshUsage!.pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        const secondFiber = yield* secondDriver.snapshot.refreshUsage!.pipe(Effect.forkChild);

        yield* TestClock.adjust("10 seconds");
        expect(fake.getAttempts()).toBe(1);
        expect(fake.getMaxConcurrent()).toBe(1);

        yield* TestClock.adjust("40 seconds");
        yield* Deferred.await(secondStarted);
        expect(fake.getAttempts()).toBe(2);
        expect(fake.getMaxConcurrent()).toBe(1);

        yield* TestClock.adjust("50 seconds");
        yield* Fiber.join(firstFiber);
        yield* Fiber.join(secondFiber);

        const firstSnapshot = yield* firstDriver.snapshot.getSnapshot;
        const secondSnapshot = yield* secondDriver.snapshot.getSnapshot;
        expect(firstSnapshot.usageLimits?.unavailable).toBeUndefined();
        expect(firstSnapshot.usageLimits?.windows.length).toBeGreaterThan(0);
        expect(secondSnapshot.usageLimits?.unavailable).toBeUndefined();
        expect(secondSnapshot.usageLimits?.windows.length).toBeGreaterThan(0);
        expect(fake.getMaxConcurrent()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "deduplicates Antigravity accounts across environments via Google userinfo, caches identity, and recovers from transient failures",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-identity-" });
        const installation = yield* makeManagedAntigravityInstallation(baseDir);
        const fake = makeQuotaSpawner(() => ({}));
        let failUserInfo = false;
        const google = makeGoogleIdentityHttpClient({
          userIdByRefreshToken: {
            "refresh-machine-a": "google-sub-42",
            "refresh-machine-b": "google-sub-42",
            "refresh-transient": "google-sub-99",
          },
          shouldFailUserInfo: () => failUserInfo,
        });

        const createDriver = (instanceId: ProviderInstanceId, displayName: string) =>
          AntigravityDriver.create({
            instanceId,
            displayName,
            enabled: true,
            config: AntigravityDriver.defaultConfig(),
            environment: [],
          }).pipe(
            Effect.provideService(AntigravityInstallation.AntigravityInstallation, installation),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
            Effect.provideService(HttpClient.HttpClient, google.client),
          );

        const idA = ProviderInstanceId.make("agy-env-a");
        const idB = ProviderInstanceId.make("agy-env-b");
        yield* writeTokenFile(idA, "refresh-machine-a");
        yield* writeTokenFile(idB, "refresh-machine-b");

        const driverA = yield* createDriver(idA, "Personal (Mac)");
        const driverB = yield* createDriver(idB, "Personal (Windows)");
        yield* driverA.snapshot.refreshUsage!;
        yield* driverB.snapshot.refreshUsage!;

        const snapA = yield* driverA.snapshot.getSnapshot;
        const snapB = yield* driverB.snapshot.getSnapshot;
        expect(snapA.usageLimits?.credentialFingerprint).toBeDefined();
        expect(snapA.usageLimits?.credentialFingerprint).toBe(
          snapB.usageLimits?.credentialFingerprint,
        );

        const merged = collectLimitAccounts(
          new Map([
            [
              EnvironmentId.make("env-a"),
              {
                entry: { target: { label: "Mac" } },
                serverConfig: {
                  providers: [{ ...snapA, installed: true, status: "ready" as const }],
                },
              },
            ],
            [
              EnvironmentId.make("env-b"),
              {
                entry: { target: { label: "Windows" } },
                serverConfig: {
                  providers: [{ ...snapB, installed: true, status: "ready" as const }],
                },
              },
            ],
          ]),
        );
        expect(merged).toHaveLength(1);

        // Identity lookup is cached across quota TTL expiries until sign-out clears it.
        const callsBeforeSecondTtl = google.getUserInfoCalls();
        yield* TestClock.adjust("6 minutes");
        yield* driverA.snapshot.refreshUsage!;
        expect(google.getUserInfoCalls()).toBe(callsBeforeSecondTtl);

        yield* driverA.auth!.logout!(Effect.void);
        yield* writeTokenFile(idA, "refresh-machine-a");
        yield* driverA.snapshot.refreshUsage!;
        expect(google.getUserInfoCalls()).toBe(callsBeforeSecondTtl + 1);

        // Transient userinfo failure falls back without failing the quota probe and retries next read.
        const idTransient = ProviderInstanceId.make("agy-transient");
        yield* writeTokenFile(idTransient, "refresh-transient");
        const driverTransient = yield* createDriver(idTransient, "Transient");
        failUserInfo = true;
        yield* driverTransient.snapshot.refreshUsage!;
        const fallbackSnap = yield* driverTransient.snapshot.getSnapshot;
        expect(fallbackSnap.usageLimits?.unavailable).toBeUndefined();
        expect(fallbackSnap.usageLimits?.windows.length).toBeGreaterThan(0);
        const fallbackFingerprint = fallbackSnap.usageLimits?.credentialFingerprint;
        expect(fallbackFingerprint).toBeDefined();

        failUserInfo = false;
        yield* TestClock.adjust("6 minutes");
        yield* driverTransient.snapshot.refreshUsage!;
        const resolvedSnap = yield* driverTransient.snapshot.getSnapshot;
        expect(resolvedSnap.usageLimits?.credentialFingerprint).toBeDefined();
        expect(resolvedSnap.usageLimits?.credentialFingerprint).not.toBe(fallbackFingerprint);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "probes Gemini Enterprise usage only when acp_business_token.json exists without starting interactive sign-in",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-enterprise-" });
        const installation = yield* makeManagedAntigravityInstallation(baseDir);
        const fake = makeQuotaSpawner(() => ({}));
        const google = makeGoogleIdentityHttpClient({
          userIdByRefreshToken: { "refresh-enterprise": "google-enterprise-sub-1" },
        });
        const enterpriseConfig = {
          ...AntigravityDriver.defaultConfig(),
          authMethod: "oauth-business" as const,
          gcpProject: "enterprise-project",
          gcpLocation: "us-central1",
        };
        const createEnterpriseDriver = (instanceId: ProviderInstanceId, displayName: string) =>
          AntigravityDriver.create({
            instanceId,
            displayName,
            enabled: true,
            config: enterpriseConfig,
            environment: [],
          }).pipe(
            Effect.provideService(AntigravityInstallation.AntigravityInstallation, installation),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
            Effect.provideService(HttpClient.HttpClient, google.client),
          );

        // Signed-out Enterprise profile with only an unrelated personal token must stay unsupported and never spawn.
        const signedOutId = ProviderInstanceId.make("agy-enterprise-signed-out");
        yield* writeTokenFile(signedOutId, "refresh-personal-only", "acp_token.json");
        const signedOutDriver = yield* createEnterpriseDriver(signedOutId, "Enterprise Signed Out");
        yield* signedOutDriver.snapshot.refreshUsage!;
        const signedOutSnap = yield* signedOutDriver.snapshot.getSnapshot;
        expect(signedOutSnap.usageLimits?.unavailable?.reason).toBe("unsupported");
        expect(fake.getAttempts()).toBe(0);

        // Signed-in Enterprise profile with acp_business_token.json probes /usage and computes credentialFingerprint.
        const signedInId = ProviderInstanceId.make("agy-enterprise-signed-in");
        yield* writeTokenFile(signedInId, "refresh-enterprise", "acp_business_token.json");
        const signedInDriver = yield* createEnterpriseDriver(signedInId, "Enterprise Signed In");
        yield* signedInDriver.snapshot.refreshUsage!;
        const signedInSnap = yield* signedInDriver.snapshot.getSnapshot;
        expect(signedInSnap.usageLimits?.unavailable).toBeUndefined();
        expect(signedInSnap.usageLimits?.windows.length).toBeGreaterThan(0);
        expect(signedInSnap.usageLimits?.credentialFingerprint).toBeDefined();
        expect(fake.getAttempts()).toBe(1);
      }).pipe(Effect.scoped),
  );
});
