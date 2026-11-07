import {
  boundedProviderMcpMessage,
  displayProviderMcpCommand,
  displayProviderMcpUrl,
  ProviderMcpError,
  type ProviderInstanceId,
  type ProviderMcpOperation,
  type ProviderMcpServer,
  type ProviderMcpServerConfig,
  type ProviderMcpServerOrigin,
  type ProviderMcpServerStatus,
  type ProviderMcpTransport,
} from "@t3tools/contracts";
import type { ProviderMcpManagement } from "@t3tools/provider-core/server/driver";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type McpServerStatus as ClaudeMcpServerStatus,
  type Query as ClaudeQuery,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { editClaudeJsonFile, readClaudeMcpServers } from "./ClaudeAccountHome.ts";
import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";

const CLI_TIMEOUT = Duration.seconds(30);
const SESSION_START_TIMEOUT = Duration.seconds(30);
// Starting Claude plus waiting for slow servers stays under this.
const LIST_TIMEOUT = Duration.minutes(1);
const CONTROL_TIMEOUT = Duration.seconds(30);
const STATUS_POLL_INTERVAL = Duration.millis(500);
// Local servers that take longer to start list as starting instead of holding the page.
const STATUS_SETTLE_POLLS = 30;
const SIGN_IN_POLL_INTERVAL = Duration.seconds(1);

const SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

const CLAUDE_STATUSES: Record<ClaudeMcpServerStatus["status"], ProviderMcpServerStatus> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "needsAuth",
  pending: "starting",
  disabled: "disabled",
};

/** The SDK sends these control requests without declaring them on `Query`. */
interface ClaudeMcpAuthControls {
  readonly mcpAuthenticate: (serverName: string) => Promise<unknown>;
  readonly mcpSubmitOAuthCallbackUrl: (serverName: string, callbackUrl: string) => Promise<unknown>;
}

const hasMcpAuthControls = (query: ClaudeQuery): query is ClaudeQuery & ClaudeMcpAuthControls =>
  typeof Reflect.get(query, "mcpAuthenticate") === "function" &&
  typeof Reflect.get(query, "mcpSubmitOAuthCallbackUrl") === "function";

const ClaudeMcpAuthenticateResponse = Schema.Struct({
  authUrl: Schema.optional(Schema.String),
  requiresUserAction: Schema.optional(Schema.Boolean),
});
const decodeAuthenticateResponse = Schema.decodeUnknownEffect(ClaudeMcpAuthenticateResponse);

/** Claude names a plugin's servers `plugin:<plugin>:<server>`. */
function splitPluginServerName(name: string) {
  const match = /^plugin:([^:]+):(.+)$/u.exec(name);
  return match?.[1] && match[2] ? { plugin: match[1], server: match[2] } : undefined;
}

function claudeOrigin(status: ClaudeMcpServerStatus): ProviderMcpServerOrigin {
  switch (status.source ?? status.scope) {
    case "plugin":
      return "plugin";
    case "claudeai":
      return "connector";
    case "managed":
    case "enterprise":
      return "managed";
    default:
      return "config";
  }
}

const hasAuthorizationHeader = (headers: Record<string, string> | undefined) =>
  Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");

const decodeSettingsJson = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const isProviderMcpError = Schema.is(ProviderMcpError);

// Bounded to the longest name a provider instance can store.
const UNSET_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/u;

/** Claude sends `${NAME}` as written when NAME is unset, and the server rejects it. */
function unsetVariable(values: ReadonlyArray<string>) {
  for (const value of values) {
    const name = UNSET_VARIABLE.exec(value)?.[1];
    if (name) return name;
  }
  return undefined;
}

function claudeMcpMessage(
  serverStatus: ProviderMcpServerStatus,
  error: string | undefined,
  missingVariable: string | undefined,
) {
  if (serverStatus === "notConfigured") {
    return "The plugin leaves its address blank. Connect the matching connector on claude.ai instead.";
  }
  if (serverStatus !== "failed") return undefined;
  return missingVariable
    ? `Claude has no ${missingVariable} to send. Add it to this provider's environment variables.`
    : boundedProviderMcpMessage(error);
}

/** How a server is reached, and whether a fixed Authorization header stands in for a sign-in. */
function describeClaudeMcpConfig(config: ClaudeMcpServerStatus["config"]): {
  readonly transport?: ProviderMcpTransport;
  readonly target?: string | undefined;
  readonly headerAuth?: boolean;
  /** Plugins such as Anthropic's `engineering` leave a slot blank for a claude.ai connector. */
  readonly blankUrl?: boolean;
  readonly unsetVariable?: string | undefined;
} {
  if (config === undefined || config.type === "claudeai-proxy" || config.type === "sdk") return {};
  if (config.type === "http" || config.type === "sse") {
    return {
      transport: config.type,
      target: displayProviderMcpUrl(config.url),
      headerAuth: hasAuthorizationHeader(config.headers),
      blankUrl: config.url.trim() === "",
      unsetVariable: unsetVariable([config.url, ...Object.values(config.headers ?? {})]),
    };
  }
  return {
    transport: "stdio",
    target: displayProviderMcpCommand(config.command, config.args ?? []),
  };
}

const ClaudeStoredMcpServer = Schema.Struct({
  type: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeStoredMcpServer = Schema.decodeUnknownOption(ClaudeStoredMcpServer);

/** A user server from `.claude.json` as this page edits it; SSE servers have no form here. */
function claudeStoredMcpServer(entry: unknown): ProviderMcpServerConfig | undefined {
  const stored = Option.getOrUndefined(decodeStoredMcpServer(entry));
  if (stored?.type === "http" && stored.url) {
    return { transport: "http", url: stored.url, headers: stored.headers ?? {} };
  }
  if ((stored?.type === undefined || stored.type === "stdio") && stored?.command) {
    return {
      transport: "stdio",
      command: stored.command,
      args: stored.args ?? [],
      env: stored.env ?? {},
    };
  }
  return undefined;
}

/**
 * Claude only turns a server off per project. A `deniedMcpServers` entry in the user's
 * settings.json, which Claude merges from every settings file, turns it off everywhere; Claude
 * then leaves the server out of its own list, so it is listed here from the config.
 */
export interface ClaudeUserMcpConfig {
  readonly servers: Readonly<Record<string, unknown>>;
  readonly turnedOff: ReadonlySet<string>;
}

const NO_USER_CONFIG: ClaudeUserMcpConfig = { servers: {}, turnedOff: new Set() };

function turnedOffServer(name: string, entry: unknown): ProviderMcpServer {
  const stored = claudeStoredMcpServer(entry);
  const sse = Option.getOrUndefined(decodeStoredMcpServer(entry));
  const described =
    stored?.transport === "http"
      ? { transport: "http" as const, target: displayProviderMcpUrl(stored.url) }
      : stored?.transport === "stdio"
        ? {
            transport: "stdio" as const,
            target: displayProviderMcpCommand(stored.command, stored.args),
          }
        : sse?.type === "sse" && sse.url
          ? { transport: "sse" as const, target: displayProviderMcpUrl(sse.url) }
          : {};
  return {
    name,
    ...(described.transport ? { transport: described.transport } : {}),
    ...(described.target ? { target: described.target } : {}),
    status: "disabled",
    origin: "config",
    canSignIn: false,
    canSignOut: false,
    removable: true,
    canToggle: true,
    canEdit: stored !== undefined,
  };
}

export function claudeMcpServers(
  statuses: ReadonlyArray<ClaudeMcpServerStatus>,
  user: ClaudeUserMcpConfig = NO_USER_CONFIG,
): ReadonlyArray<ProviderMcpServer> {
  const listed = statuses.flatMap((status): ReadonlyArray<ProviderMcpServer> => {
    const config = status.config;
    // In-process servers belong to the session that registered them, never to the config.
    if (status.source === "sdk" || config?.type === "sdk") return [];
    const origin = claudeOrigin(status);
    const plugin = origin === "plugin" ? splitPluginServerName(status.name) : undefined;
    const { transport, target, headerAuth = false, ...described } = describeClaudeMcpConfig(config);
    const serverStatus = described.blankUrl
      ? "notConfigured"
      : user.turnedOff.has(status.name) && status.scope === "user"
        ? "disabled"
        : CLAUDE_STATUSES[status.status];
    const missingVariable = serverStatus === "failed" ? described.unsetVariable : undefined;
    const message = claudeMcpMessage(serverStatus, status.error, missingVariable);
    const signsInHere = (transport === "http" || transport === "sse") && origin !== "connector";
    return [
      {
        name: status.name,
        ...(plugin ? { displayName: plugin.server, plugin: plugin.plugin } : {}),
        ...(transport ? { transport } : {}),
        ...(target ? { target } : {}),
        status: serverStatus,
        ...(message ? { message } : {}),
        ...(serverStatus === "connected" && status.tools ? { toolCount: status.tools.length } : {}),
        ...(missingVariable ? { missingVariable } : {}),
        origin,
        canSignIn: signsInHere && serverStatus === "needsAuth",
        // A server sent a fixed Authorization header has no sign-in to clear.
        canSignOut: signsInHere && serverStatus === "connected" && !headerAuth,
        // Servers in a project's or the local scope belong to that folder, not this page.
        removable: status.scope === "user",
        canToggle: status.scope === "user",
        canEdit: status.scope === "user" && (transport === "http" || transport === "stdio"),
      },
    ];
  });
  const names = new Set(listed.map((server) => server.name));
  const turnedOff = [...user.turnedOff]
    .filter((name) => !names.has(name) && Object.hasOwn(user.servers, name))
    .map((name) => turnedOffServer(name, user.servers[name]));
  return [...listed, ...turnedOff];
}

/** `deniedMcpServers` with one server's own entry added or taken out; other entries stay. */
function claudeDeniedMcpServers(current: unknown, name: string, denied: boolean) {
  const entries: ReadonlyArray<unknown> = Array.isArray(current) ? current : [];
  const isOwnEntry = (entry: unknown) =>
    typeof entry === "object" &&
    entry !== null &&
    Object.keys(entry).length === 1 &&
    Reflect.get(entry, "serverName") === name;
  const others = entries.filter((entry) => !isOwnEntry(entry));
  return denied ? [...others, { serverName: name }] : others;
}

/** The names a settings.json turns off with an entry of their own. */
function claudeTurnedOffMcpServers(settings: Readonly<Record<string, unknown>>) {
  const entries: ReadonlyArray<unknown> = Array.isArray(settings.deniedMcpServers)
    ? settings.deniedMcpServers
    : [];
  return new Set(
    entries.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Object.keys(entry).length !== 1) return [];
      const name: unknown = Reflect.get(entry, "serverName");
      return typeof name === "string" ? [name] : [];
    }),
  );
}

/** The entry Claude keeps for a server, without empty header or environment tables. */
export function claudeMcpServerEntry(server: ProviderMcpServerConfig): Record<string, unknown> {
  if (server.transport === "http") {
    return {
      type: "http",
      url: server.url,
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    };
  }
  return {
    type: "stdio",
    command: server.command,
    args: server.args,
    ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
  };
}

const TRANSPORT_KEYS = new Set(["type", "url", "headers", "command", "args", "env"]);

/** A server's entry with a new address or command; settings this page does not show stay. */
function editedClaudeMcpServerEntry(current: unknown, server: ProviderMcpServerConfig) {
  const kept =
    typeof current === "object" && current !== null
      ? Object.fromEntries(Object.entries(current).filter(([key]) => !TRANSPORT_KEYS.has(key)))
      : {};
  return { ...claudeMcpServerEntry(server), ...kept };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Manages the MCP servers in a Claude config folder through `claude mcp` and Claude's SDK. */
export const makeClaudeMcpManagement = Effect.fn("makeClaudeMcpManagement")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** Carries `CLAUDE_CONFIG_DIR` for an added account's own folder. */
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** This account's `.claude.json`, where Claude keeps user MCP servers. */
  readonly configPath: string;
  /** The user settings.json every account on this config reads. */
  readonly settingsPath: string;
  /** An added account copies the shared config's servers, so its changes go to that config. */
  readonly sharedConfig?: {
    readonly environment: NodeJS.ProcessEnv;
    readonly configPath: string;
    readonly copyServers: Effect.Effect<void>;
  };
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const executablePath = yield* resolveClaudeSdkExecutablePath(
    options.binaryPath,
    options.environment,
  );
  // Claude rewrites its whole config file for every change.
  const writes = yield* Semaphore.make(1);

  const failure = (operation: ProviderMcpOperation, providerMessage?: string, cause?: unknown) =>
    new ProviderMcpError({
      operation,
      instanceId: options.instanceId,
      reason: "providerFailed",
      ...(providerMessage ? { providerMessage } : {}),
      ...(cause === undefined ? {} : { cause }),
    });
  const thrown = (operation: ProviderMcpOperation) => (cause: unknown) =>
    failure(
      operation,
      cause instanceof Error ? boundedProviderMcpMessage(cause.message) : undefined,
      cause,
    );

  const run = Effect.fn("ClaudeMcp.run")(
    function* (
      _operation: ProviderMcpOperation,
      args: ReadonlyArray<string>,
      environment: NodeJS.ProcessEnv,
    ) {
      const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, args, {
        env: environment,
      });
      return yield* spawnAndCollect(
        options.binaryPath,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
          cwd: options.cwd,
        }),
      );
    },
    (effect, operation) =>
      effect.pipe(
        Effect.timeout(CLI_TIMEOUT),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) => failure(operation, undefined, cause)),
      ),
  );

  const mutate = (
    operation: ProviderMcpOperation,
    args: ReadonlyArray<string>,
    environment = options.environment,
  ) =>
    run(operation, args, environment).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.void
          : Effect.fail(
              failure(
                operation,
                boundedProviderMcpMessage(result.stderr) ??
                  boundedProviderMcpMessage(result.stdout),
              ),
            ),
      ),
      writes.withPermits(1),
    );

  /** Claude without a prompt: its MCP control requests work and nothing reaches the API. */
  const openSession = Effect.fn("ClaudeMcp.openSession")(function* (
    operation: ProviderMcpOperation,
  ) {
    const abort = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort()),
    );
    const query = claudeQuery({
      // oxlint-disable-next-line require-yield -- never yields, so no prompt reaches the API
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbort(abort.signal);
      })(),
      options: {
        persistSession: false,
        pathToClaudeCodeExecutable: executablePath,
        abortController: abort,
        settingSources: [...SETTING_SOURCES],
        settings: { disableAllHooks: true },
        allowedTools: [],
        env: {
          ...options.environment,
          FORCE_CODE_TERMINAL: undefined,
          CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
          CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
        },
        cwd: options.cwd,
        stderr: () => {},
      },
    });
    yield* Effect.tryPromise({
      try: () => query.initializationResult(),
      catch: thrown(operation),
    }).pipe(
      Effect.timeoutOrElse({
        duration: SESSION_START_TIMEOUT,
        orElse: () => Effect.fail(failure(operation, "Claude did not start in time.")),
      }),
    );
    return query;
  });

  const statuses = (query: ClaudeQuery, operation: ProviderMcpOperation) =>
    Effect.tryPromise({ try: () => query.mcpServerStatus(), catch: thrown(operation) });

  const settledStatuses = Effect.fn("ClaudeMcp.settledStatuses")(function* (query: ClaudeQuery) {
    for (let poll = 1; ; poll += 1) {
      const current = yield* statuses(query, "list");
      if (poll >= STATUS_SETTLE_POLLS || !current.some((status) => status.status === "pending")) {
        return current;
      }
      yield* Effect.sleep(STATUS_POLL_INTERVAL);
    }
  });

  const awaitConnected = Effect.fn("ClaudeMcp.awaitConnected")(function* (
    query: ClaudeQuery,
    name: string,
  ) {
    for (;;) {
      yield* Effect.sleep(SIGN_IN_POLL_INTERVAL);
      const status = (yield* statuses(query, "signIn")).find((entry) => entry.name === name);
      if (status?.status === "connected") return;
      if (status?.status === "failed") {
        return yield* failure("signIn", boundedProviderMcpMessage(status.error));
      }
    }
  });

  const shared = options.sharedConfig;
  const syncShared = shared?.copyServers ?? Effect.void;

  const userServers = (configPath: string) =>
    readClaudeMcpServers(configPath).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  const readSettings = fileSystem.readFileString(options.settingsPath).pipe(
    Effect.flatMap(decodeSettingsJson),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})),
  );

  const readUserConfig = Effect.all([
    userServers(options.configPath),
    readSettings.pipe(
      Effect.map(claudeTurnedOffMcpServers),
      Effect.catch((error) =>
        Effect.logWarning("Claude's settings.json could not be read.", {
          path: options.settingsPath,
          error,
        }).pipe(Effect.as(new Set<string>())),
      ),
    ),
  ]).pipe(Effect.map(([servers, turnedOff]): ClaudeUserMcpConfig => ({ servers, turnedOff })));

  /** Which config a change goes to: the shared one for a server every account has. */
  const owningConfig = (name: string) =>
    shared === undefined
      ? Effect.succeed({ configPath: options.configPath, environment: options.environment })
      : userServers(shared.configPath).pipe(
          Effect.map((servers) =>
            Object.hasOwn(servers, name)
              ? { configPath: shared.configPath, environment: shared.environment }
              : { configPath: options.configPath, environment: options.environment },
          ),
        );

  const storedServer = Effect.fn("ClaudeMcp.storedServer")(function* (
    operation: ProviderMcpOperation,
    name: string,
  ) {
    yield* syncShared;
    const servers = yield* userServers(options.configPath);
    if (!Object.hasOwn(servers, name)) {
      return yield* failure(operation, `Claude's user config has no MCP server named ${name}.`);
    }
    return servers[name];
  });

  const setTurnedOff = (operation: ProviderMcpOperation, name: string, turnedOff: boolean) =>
    editClaudeJsonFile(
      options.settingsPath,
      (settings) => {
        const denied = claudeDeniedMcpServers(settings.deniedMcpServers, name, turnedOff);
        const { deniedMcpServers: _previous, ...rest } = settings;
        return Effect.succeed(denied.length > 0 ? { ...rest, deniedMcpServers: denied } : rest);
      },
      { lock: false },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError((cause) =>
        failure(operation, "Claude's settings.json could not be changed.", cause),
      ),
    );

  return {
    list: syncShared.pipe(
      Effect.andThen(
        Effect.all([openSession("list").pipe(Effect.flatMap(settledStatuses)), readUserConfig]),
      ),
      Effect.map(([statuses, user]) => claudeMcpServers(statuses, user)),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: LIST_TIMEOUT,
        orElse: () => Effect.fail(failure("list", "Claude did not list its MCP servers in time.")),
      }),
    ),
    add: (name, server) => {
      const args = [
        "mcp",
        "add-json",
        "--scope",
        "user",
        name,
        JSON.stringify(claudeMcpServerEntry(server)),
      ];
      return shared === undefined
        ? mutate("add", args)
        : mutate("add", args, shared.environment).pipe(Effect.andThen(shared.copyServers));
    },
    remove: (name) =>
      owningConfig(name).pipe(
        Effect.flatMap(({ environment }) =>
          mutate("remove", ["mcp", "remove", "--scope", "user", name], environment),
        ),
        Effect.andThen(syncShared),
        // A later server with the same name would otherwise start out turned off.
        Effect.andThen(
          setTurnedOff("remove", name, false).pipe(
            writes.withPermits(1),
            Effect.catch((error) =>
              Effect.logWarning("The removed server's switch was left in Claude's settings.", {
                name,
                error,
              }),
            ),
          ),
        ),
      ),
    read: (name) =>
      storedServer("read", name).pipe(
        Effect.flatMap((entry) => {
          const stored = claudeStoredMcpServer(entry);
          return stored === undefined
            ? Effect.fail(failure("read", "Change this server with `claude mcp` instead."))
            : Effect.succeed(stored);
        }),
      ),
    edit: (name, server) =>
      owningConfig(name).pipe(
        Effect.flatMap(({ configPath }) =>
          editClaudeJsonFile(
            configPath,
            (config) => {
              const servers =
                typeof config.mcpServers === "object" && config.mcpServers !== null
                  ? (config.mcpServers as Readonly<Record<string, unknown>>)
                  : {};
              if (!Object.hasOwn(servers, name)) {
                return Effect.fail(
                  failure("edit", `Claude's user config has no MCP server named ${name}.`),
                );
              }
              return Effect.succeed({
                ...config,
                mcpServers: {
                  ...servers,
                  [name]: editedClaudeMcpServerEntry(servers[name], server),
                },
              });
            },
            { lock: true },
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
        ),
        Effect.mapError((cause) =>
          isProviderMcpError(cause) ? cause : failure("edit", undefined, cause),
        ),
        writes.withPermits(1),
        Effect.andThen(syncShared),
      ),
    setEnabled: (name, enabled) =>
      storedServer("setEnabled", name).pipe(
        Effect.andThen(setTurnedOff("setEnabled", name, !enabled).pipe(writes.withPermits(1))),
      ),
    signOut: (name) => mutate("signOut", ["mcp", "logout", name]),
    signIn: Effect.fn("ClaudeMcp.signIn")(function* (name) {
      const query = yield* openSession("signIn");
      if (!hasMcpAuthControls(query)) {
        return yield* new ProviderMcpError({
          operation: "signIn",
          instanceId: options.instanceId,
          reason: "unsupported",
        });
      }
      const response = yield* Effect.tryPromise({
        try: () => query.mcpAuthenticate(name),
        catch: thrown("signIn"),
      }).pipe(
        Effect.timeoutOrElse({
          duration: CONTROL_TIMEOUT,
          orElse: () => Effect.fail(failure("signIn", "Claude did not start the sign-in in time.")),
        }),
        Effect.flatMap((raw) =>
          decodeAuthenticateResponse(raw).pipe(
            Effect.mapError((cause) => failure("signIn", undefined, cause)),
          ),
        ),
      );
      if (response.requiresUserAction === false) {
        return {
          authorizationUrl: undefined,
          completed: Effect.void,
          submitCallbackUrl: () => Effect.void,
        };
      }
      if (!response.authUrl)
        return yield* failure("signIn", "Claude did not return a sign-in page.");
      return {
        authorizationUrl: response.authUrl,
        completed: awaitConnected(query, name),
        submitCallbackUrl: (callbackUrl) =>
          Effect.tryPromise({
            try: () => query.mcpSubmitOAuthCallbackUrl(name, callbackUrl),
            catch: thrown("signIn"),
          }).pipe(
            Effect.timeoutOrElse({
              duration: CONTROL_TIMEOUT,
              orElse: () =>
                Effect.fail(failure("signIn", "Claude did not take the address in time.")),
            }),
            Effect.asVoid,
          ),
      };
    }),
  } satisfies ProviderMcpManagement;
});
