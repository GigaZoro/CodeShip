import {
  boundedProviderMcpMessage,
  displayProviderMcpCommand,
  displayProviderMcpUrl,
  PROVIDER_MCP_NEW_SERVER_NAME_PATTERN,
  ProviderMcpError,
  type ProviderInstanceId,
  type ProviderMcpOperation,
  type ProviderMcpServer,
  type ProviderMcpServerConfig,
  type ProviderMcpServerStatus,
  splitProviderPluginId,
} from "@t3tools/contracts";
import type { ProviderMcpManagement } from "@t3tools/provider-core/server/driver";
import { mcpCallbackUrl, mcpRedirect, type McpRedirect } from "@t3tools/shared/mcpAuthCallback";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";

const CONFIG_TIMEOUT = Duration.seconds(30);
// Listing connects to every server, and local ones may take a while to start.
const STATUS_TIMEOUT = Duration.minutes(1);
const CLI_TIMEOUT = Duration.seconds(30);
const CALLBACK_TIMEOUT = Duration.seconds(15);
// Codex keeps its callback page open this long; ProviderMcp gives up at the same time.
const SIGN_IN_TIMEOUT_SECONDS = 300;
const STATUS_PAGE_SIZE = 100;
const STATUS_MAX_PAGES = 5;

const MANAGED_CONFIG_LAYERS = new Set([
  "enterpriseManaged",
  "mdm",
  "legacyManagedConfigTomlFromFile",
  "legacyManagedConfigTomlFromMdm",
]);

const CodexMcpServerEntry = Schema.Struct({
  url: Schema.optional(Schema.String),
  http_headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});
type CodexMcpServerEntry = typeof CodexMcpServerEntry.Type;
const decodeServerEntry = Schema.decodeUnknownOption(CodexMcpServerEntry);

// Codex rejects a server that mixes a local command's settings with a remote address's.
const REMOTE_KEYS = ["url", "http_headers", "env_http_headers", "bearer_token_env_var"];
const LOCAL_KEYS = ["command", "args", "env", "env_vars", "cwd"];

export interface CodexConfiguredMcpServer extends CodexMcpServerEntry {
  /** Only servers in the user's own config.toml can be changed here. */
  readonly userConfig: boolean;
  readonly managed: boolean;
  /** Every setting its table has, including ones this page does not show. */
  readonly keys: ReadonlySet<string>;
}

type CodexMcpStatus = CodexSchema.V2ListMcpServerStatusResponse["data"][number];

/** The servers in Codex's effective config, keyed by name. */
export function codexConfiguredMcpServers(
  response: CodexSchema.V2ConfigReadResponse,
): ReadonlyMap<string, CodexConfiguredMcpServer> {
  const table: unknown = Reflect.get(response.config, "mcp_servers");
  const servers = new Map<string, CodexConfiguredMcpServer>();
  if (typeof table !== "object" || table === null) return servers;
  for (const [name, value] of Object.entries(table)) {
    const entry = decodeServerEntry(value);
    if (Option.isNone(entry)) continue;
    const origin =
      response.origins[`mcp_servers.${name}.url`] ??
      response.origins[`mcp_servers.${name}.command`];
    servers.set(name, {
      ...entry.value,
      userConfig: origin === undefined || origin.name.type === "user",
      managed: origin !== undefined && MANAGED_CONFIG_LAYERS.has(origin.name.type),
      keys: new Set(typeof value === "object" && value !== null ? Object.keys(value) : []),
    });
  }
  return servers;
}

function codexStatus(
  entry: CodexConfiguredMcpServer | undefined,
  status: CodexMcpStatus | undefined,
): ProviderMcpServerStatus {
  if (entry?.enabled === false) return "disabled";
  if (status?.authStatus === "notLoggedIn") return "needsAuth";
  if (status === undefined || status.toolsError) return "failed";
  return "connected";
}

export function codexMcpServers(
  configured: ReadonlyMap<string, CodexConfiguredMcpServer>,
  statuses: ReadonlyArray<CodexMcpStatus>,
): ReadonlyArray<ProviderMcpServer> {
  const statusByName = new Map(statuses.map((status) => [status.name, status]));
  const names = new Set([...configured.keys(), ...statusByName.keys()]);
  return [...names].map((name): ProviderMcpServer => {
    const entry = configured.get(name);
    const status = statusByName.get(name);
    const serverStatus = codexStatus(entry, status);
    const target = entry?.url
      ? displayProviderMcpUrl(entry.url)
      : entry?.command
        ? displayProviderMcpCommand(entry.command, entry.args ?? [])
        : (status?.httpOrigin ?? undefined);
    const transport = entry?.url
      ? "http"
      : entry?.command
        ? "stdio"
        : status?.httpOrigin
          ? "http"
          : undefined;
    const message =
      serverStatus !== "failed"
        ? undefined
        : status === undefined
          ? "Codex did not report this server."
          : boundedProviderMcpMessage(status.toolsError);
    const plugin = status?.pluginId ? splitProviderPluginId(status.pluginId).name : undefined;
    // A dotted key path cannot address a name with dots or spaces.
    const changeable =
      entry?.userConfig === true && PROVIDER_MCP_NEW_SERVER_NAME_PATTERN.test(name);
    return {
      name,
      ...(transport ? { transport } : {}),
      ...(target ? { target } : {}),
      status: serverStatus,
      ...(message ? { message } : {}),
      ...(serverStatus === "connected" && status
        ? { toolCount: Object.keys(status.tools).length }
        : {}),
      origin: entry?.managed ? "managed" : entry ? "config" : plugin ? "plugin" : "builtIn",
      ...(plugin ? { plugin } : {}),
      canSignIn: serverStatus === "needsAuth",
      canSignOut: status?.authStatus === "oAuth",
      removable: entry?.userConfig === true,
      canToggle: changeable,
      canEdit: changeable && Boolean(entry?.url || entry?.command),
    };
  });
}

/** The stored server an edit starts from, or nothing for a table without an address or command. */
function codexStoredMcpServer(
  entry: CodexConfiguredMcpServer,
): ProviderMcpServerConfig | undefined {
  if (entry.url) return { transport: "http", url: entry.url, headers: entry.http_headers ?? {} };
  if (entry.command) {
    return {
      transport: "stdio",
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ?? {},
    };
  }
  return undefined;
}

/**
 * The writes that give `[mcp_servers.<name>]` a new address or command. Settings the page does
 * not show, such as timeouts or a bearer token variable, stay; the other transport's settings go.
 */
function codexMcpServerEdits(
  name: string,
  entry: CodexConfiguredMcpServer,
  server: ProviderMcpServerConfig,
): ReadonlyArray<CodexSchema.V2ConfigBatchWriteParams__ConfigEdit> {
  const table = codexMcpServerEntry(server);
  const [own, other] =
    server.transport === "http"
      ? (["http_headers", LOCAL_KEYS] as const)
      : (["env", REMOTE_KEYS] as const);
  const stale = [own, ...other].filter((key) => entry.keys.has(key) && !Object.hasOwn(table, key));
  return [
    ...Object.entries(table).map(([key, value]) => ({
      keyPath: `mcp_servers.${name}.${key}`,
      value,
      mergeStrategy: "replace" as const,
    })),
    ...stale.map((key) => ({
      keyPath: `mcp_servers.${name}.${key}`,
      value: null,
      mergeStrategy: "replace" as const,
    })),
  ];
}

/** The `[mcp_servers.<name>]` table Codex reads, without empty header or environment tables. */
function codexMcpServerEntry(server: ProviderMcpServerConfig) {
  if (server.transport === "http") {
    return {
      url: server.url,
      ...(Object.keys(server.headers).length > 0 ? { http_headers: { ...server.headers } } : {}),
    };
  }
  return {
    command: server.command,
    args: [...server.args],
    ...(Object.keys(server.env).length > 0 ? { env: { ...server.env } } : {}),
  };
}

/** Manages the MCP servers in a Codex home through its app server, which owns `config.toml`. */
export const makeCodexMcpManagement = Effect.fn("makeCodexMcpManagement")(function* <
  OpenError,
  CliError,
>(options: {
  readonly instanceId: ProviderInstanceId;
  /** An initialized app server for this instance's Codex home, closed with the scope. */
  readonly openClient: Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    OpenError,
    Scope.Scope
  >;
  /** Runs the Codex CLI against the same home, for what the app server cannot do. */
  readonly runCli: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly code: number; readonly stdout: string; readonly stderr: string },
    CliError
  >;
}) {
  const http = yield* HttpClient.HttpClient;
  // Codex rewrites config.toml for every change.
  const writes = yield* Semaphore.make(1);

  const failure = (operation: ProviderMcpOperation, providerMessage?: string, cause?: unknown) =>
    new ProviderMcpError({
      operation,
      instanceId: options.instanceId,
      reason: "providerFailed",
      ...(providerMessage ? { providerMessage } : {}),
      ...(cause === undefined ? {} : { cause }),
    });
  // JSON-RPC errors carry Codex's own reason, such as a name it does not know.
  const failed = (operation: ProviderMcpOperation) => (cause: unknown) =>
    failure(
      operation,
      cause instanceof Error ? boundedProviderMcpMessage(cause.message) : undefined,
      cause,
    );

  const withClient = <A>(
    operation: ProviderMcpOperation,
    timeout: Duration.Input,
    use: (
      client: CodexClient.CodexAppServerClient["Service"],
    ) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ) =>
    options.openClient.pipe(
      Effect.flatMap(use),
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(failed(operation)),
    );

  const readConfigured = (client: CodexClient.CodexAppServerClient["Service"]) =>
    client.request("config/read", {}).pipe(Effect.map(codexConfiguredMcpServers));

  const readStatuses = Effect.fn("CodexMcp.readStatuses")(function* (
    client: CodexClient.CodexAppServerClient["Service"],
  ) {
    const statuses: Array<CodexMcpStatus> = [];
    let cursor: string | undefined;
    for (let page = 0; page < STATUS_MAX_PAGES; page += 1) {
      const response = yield* client.request("mcpServerStatus/list", {
        detail: "toolsAndAuthOnly",
        limit: STATUS_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      statuses.push(...response.data);
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return statuses;
  });

  const write = (operation: ProviderMcpOperation, params: CodexSchema.V2ConfigValueWriteParams) =>
    withClient(operation, CONFIG_TIMEOUT, (client) =>
      client.request("config/value/write", params),
    ).pipe(Effect.asVoid);

  /** A server in the user's own config.toml that a dotted key path can address. */
  const ownServer = Effect.fn("CodexMcp.ownServer")(function* (
    operation: ProviderMcpOperation,
    name: string,
  ) {
    const configured = yield* withClient(operation, CONFIG_TIMEOUT, readConfigured);
    const entry = configured.get(name);
    if (entry === undefined) {
      return yield* failure(operation, `Codex has no MCP server named ${name}.`);
    }
    if (!entry.userConfig || !PROVIDER_MCP_NEW_SERVER_NAME_PATTERN.test(name)) {
      return yield* failure(operation, "Change this server in config.toml by hand.");
    }
    return entry;
  });

  const forwardCallback = (redirect: McpRedirect | undefined, pasted: string) => {
    const callbackUrl = redirect ? mcpCallbackUrl(pasted, redirect) : undefined;
    if (callbackUrl === undefined) {
      return Effect.fail(failure("signIn", "This address does not belong to the current sign-in."));
    }
    return http.get(callbackUrl).pipe(
      Effect.timeout(CALLBACK_TIMEOUT),
      Effect.mapError((cause) =>
        failure("signIn", "Codex is no longer waiting for this sign-in. Start it again.", cause),
      ),
      Effect.flatMap((response) =>
        response.status < 400
          ? Effect.void
          : Effect.fail(failure("signIn", "Codex did not accept this address.")),
      ),
    );
  };

  return {
    list: withClient("list", STATUS_TIMEOUT, (client) =>
      Effect.all([readConfigured(client), readStatuses(client)]),
    ).pipe(Effect.map(([configured, statuses]) => codexMcpServers(configured, statuses))),
    add: (name, server) =>
      withClient("add", CONFIG_TIMEOUT, readConfigured).pipe(
        Effect.flatMap((configured) =>
          configured.has(name)
            ? Effect.fail(failure("add", `Codex already has an MCP server named ${name}.`))
            : write("add", {
                keyPath: "mcp_servers",
                value: { [name]: codexMcpServerEntry(server) },
                mergeStrategy: "upsert",
              }),
        ),
        writes.withPermits(1),
      ),
    remove: (name) =>
      // A dotted key path cannot address a name with dots or spaces.
      PROVIDER_MCP_NEW_SERVER_NAME_PATTERN.test(name)
        ? write("remove", {
            keyPath: `mcp_servers.${name}`,
            value: null,
            mergeStrategy: "replace",
          }).pipe(writes.withPermits(1))
        : Effect.fail(failure("remove", "Remove this server from config.toml by hand.")),
    read: (name) =>
      ownServer("read", name).pipe(
        Effect.flatMap((entry) => {
          const stored = codexStoredMcpServer(entry);
          return stored === undefined
            ? Effect.fail(failure("read", "Change this server in config.toml by hand."))
            : Effect.succeed(stored);
        }),
      ),
    edit: (name, server) =>
      ownServer("edit", name).pipe(
        Effect.flatMap((entry) =>
          // One write, so a failed edit leaves the server as it was.
          withClient("edit", CONFIG_TIMEOUT, (client) =>
            client.request("config/batchWrite", {
              edits: codexMcpServerEdits(name, entry, server),
            }),
          ),
        ),
        Effect.asVoid,
        writes.withPermits(1),
      ),
    setEnabled: (name, enabled) =>
      ownServer("setEnabled", name).pipe(
        Effect.andThen(
          write("setEnabled", {
            keyPath: `mcp_servers.${name}.enabled`,
            value: enabled,
            mergeStrategy: "replace",
          }),
        ),
        writes.withPermits(1),
      ),
    signOut: (name) =>
      options.runCli(["mcp", "logout", name]).pipe(
        Effect.timeout(CLI_TIMEOUT),
        Effect.mapError(failed("signOut")),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.void
            : Effect.fail(
                failure(
                  "signOut",
                  boundedProviderMcpMessage(result.stderr) ??
                    boundedProviderMcpMessage(result.stdout),
                ),
              ),
        ),
      ),
    signIn: Effect.fn("CodexMcp.signIn")(function* (name) {
      // The app server hosts the callback page, so it stays open for the whole sign-in.
      const client = yield* options.openClient.pipe(Effect.mapError(failed("signIn")));
      const completed = yield* Deferred.make<void, ProviderMcpError>();
      yield* client.handleServerNotification("mcpServer/oauthLogin/completed", (event) =>
        event.name !== name
          ? Effect.void
          : event.success
            ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
            : Deferred.fail(
                completed,
                failure("signIn", boundedProviderMcpMessage(event.error)),
              ).pipe(Effect.asVoid),
      );
      const { authorizationUrl } = yield* client
        .request("mcpServer/oauth/login", { name, timeoutSecs: SIGN_IN_TIMEOUT_SECONDS })
        .pipe(Effect.timeout(CONFIG_TIMEOUT), Effect.mapError(failed("signIn")));
      const redirect = mcpRedirect(authorizationUrl);
      return {
        authorizationUrl,
        completed: Deferred.await(completed),
        submitCallbackUrl: (callbackUrl) => forwardCallback(redirect, callbackUrl),
      };
    }),
  } satisfies ProviderMcpManagement;
});
