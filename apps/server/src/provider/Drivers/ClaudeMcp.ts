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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

/** How a server is reached, and whether a fixed Authorization header stands in for a sign-in. */
function describeClaudeMcpConfig(config: ClaudeMcpServerStatus["config"]): {
  readonly transport?: ProviderMcpTransport;
  readonly target?: string | undefined;
  readonly headerAuth?: boolean;
} {
  if (config === undefined || config.type === "claudeai-proxy" || config.type === "sdk") return {};
  if (config.type === "http" || config.type === "sse") {
    return {
      transport: config.type,
      target: displayProviderMcpUrl(config.url),
      headerAuth: hasAuthorizationHeader(config.headers),
    };
  }
  return {
    transport: "stdio",
    target: displayProviderMcpCommand(config.command, config.args ?? []),
  };
}

export function claudeMcpServers(
  statuses: ReadonlyArray<ClaudeMcpServerStatus>,
): ReadonlyArray<ProviderMcpServer> {
  return statuses.flatMap((status): ReadonlyArray<ProviderMcpServer> => {
    const config = status.config;
    // In-process servers belong to the session that registered them, never to the config.
    if (status.source === "sdk" || config?.type === "sdk") return [];
    const origin = claudeOrigin(status);
    const plugin = origin === "plugin" ? splitPluginServerName(status.name) : undefined;
    const { transport, target, headerAuth = false } = describeClaudeMcpConfig(config);
    const serverStatus = CLAUDE_STATUSES[status.status];
    const message = serverStatus === "failed" ? boundedProviderMcpMessage(status.error) : undefined;
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
        origin,
        canSignIn: signsInHere && serverStatus === "needsAuth",
        // A server sent a fixed Authorization header has no sign-in to clear.
        canSignOut: signsInHere && serverStatus === "connected" && !headerAuth,
        // Servers in a project's or the local scope belong to that folder, not this page.
        removable: status.scope === "user",
      },
    ];
  });
}

/** The JSON `claude mcp add-json` takes, without empty header or environment tables. */
export function claudeMcpServerJson(server: ProviderMcpServerConfig) {
  if (server.transport === "http") {
    return JSON.stringify({
      type: "http",
      url: server.url,
      ...(Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    });
  }
  return JSON.stringify({
    type: "stdio",
    command: server.command,
    args: server.args,
    ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
  });
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
  /** An added account copies the shared config's servers, so its changes go to that config. */
  readonly sharedConfig?: {
    readonly environment: NodeJS.ProcessEnv;
    readonly serverNames: Effect.Effect<ReadonlySet<string>>;
    readonly copyServers: Effect.Effect<void>;
  };
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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

  return {
    list: (shared?.copyServers ?? Effect.void).pipe(
      Effect.andThen(openSession("list")),
      Effect.flatMap(settledStatuses),
      Effect.map(claudeMcpServers),
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: LIST_TIMEOUT,
        orElse: () => Effect.fail(failure("list", "Claude did not list its MCP servers in time.")),
      }),
    ),
    add: (name, server) => {
      const args = ["mcp", "add-json", "--scope", "user", name, claudeMcpServerJson(server)];
      return shared === undefined
        ? mutate("add", args)
        : mutate("add", args, shared.environment).pipe(Effect.andThen(shared.copyServers));
    },
    remove: (name) => {
      const args = ["mcp", "remove", "--scope", "user", name];
      if (shared === undefined) return mutate("remove", args);
      // A server only this account has is removed from its own config.
      return shared.serverNames.pipe(
        Effect.flatMap((names) =>
          names.has(name)
            ? mutate("remove", args, shared.environment).pipe(Effect.andThen(shared.copyServers))
            : mutate("remove", args),
        ),
      );
    },
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
