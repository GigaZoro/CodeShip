import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceEnvironmentVariableName, ProviderInstanceId } from "./providerInstance.ts";

const PROVIDER_MCP_MAX_SERVERS = 500;
const PROVIDER_MCP_MESSAGE_MAX_LENGTH = 500;
const PROVIDER_MCP_TARGET_MAX_LENGTH = 1_024;

/** Both Claude and Codex reject other names for servers they add. */
export const PROVIDER_MCP_NEW_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
export const PROVIDER_MCP_NEW_SERVER_NAME_MAX_LENGTH = 64;
export const PROVIDER_MCP_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export const PROVIDER_MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** A server the provider already lists; plugins and connectors name theirs freely. */
export const ProviderMcpServerName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type ProviderMcpServerName = typeof ProviderMcpServerName.Type;

export const ProviderMcpNewServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_MCP_NEW_SERVER_NAME_MAX_LENGTH),
  Schema.isPattern(PROVIDER_MCP_NEW_SERVER_NAME_PATTERN),
);

export const ProviderMcpTransport = Schema.Literals(["stdio", "http", "sse"]);
export type ProviderMcpTransport = typeof ProviderMcpTransport.Type;

export const ProviderMcpServerStatus = Schema.Literals([
  "connected",
  "needsAuth",
  "failed",
  "starting",
  "disabled",
  /** A plugin left the address blank, so the server never starts. */
  "notConfigured",
]);
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

/** Only servers from the provider's own config can be removed here. */
export const ProviderMcpServerOrigin = Schema.Literals([
  "config",
  "plugin",
  "connector",
  "managed",
  "builtIn",
]);
export type ProviderMcpServerOrigin = typeof ProviderMcpServerOrigin.Type;

export const ProviderMcpServer = Schema.Struct({
  name: ProviderMcpServerName,
  /** Shorter label for plugin servers, whose names carry the plugin's prefix. */
  displayName: Schema.optionalKey(Schema.String),
  transport: Schema.optionalKey(ProviderMcpTransport),
  /** A remote server's URL without credentials or query, or a local server's command line. */
  target: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROVIDER_MCP_TARGET_MAX_LENGTH)),
  ),
  status: ProviderMcpServerStatus,
  /** The provider's reason a server failed to connect, or what a server that is not set up needs. */
  message: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROVIDER_MCP_MESSAGE_MAX_LENGTH)),
  ),
  toolCount: Schema.optionalKey(NonNegativeInt),
  /** An environment variable the server's config names but the provider does not have. */
  missingVariable: Schema.optionalKey(ProviderInstanceEnvironmentVariableName),
  origin: ProviderMcpServerOrigin,
  plugin: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  canSignIn: Schema.Boolean,
  canSignOut: Schema.Boolean,
  removable: Schema.Boolean,
  /** The provider turns it off and on without deleting it; absent from servers older than the switch. */
  canToggle: Schema.optionalKey(Schema.Boolean),
  /** Its address or command can be changed here; absent from servers older than editing. */
  canEdit: Schema.optionalKey(Schema.Boolean),
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderMcpListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Connects to the servers again instead of reading the copy kept for a short while. */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type ProviderMcpListInput = typeof ProviderMcpListInput.Type;

export const ProviderMcpListResult = Schema.Struct({
  servers: Schema.Array(ProviderMcpServer).check(Schema.isMaxLength(PROVIDER_MCP_MAX_SERVERS)),
});
export type ProviderMcpListResult = typeof ProviderMcpListResult.Type;

const ProviderMcpEnv = Schema.Record(
  Schema.String.check(Schema.isMaxLength(256), Schema.isPattern(PROVIDER_MCP_ENV_NAME_PATTERN)),
  Schema.String.check(Schema.isMaxLength(16_384)),
).check(Schema.isMaxProperties(64));

const ProviderMcpHeaders = Schema.Record(
  Schema.String.check(Schema.isMaxLength(256), Schema.isPattern(PROVIDER_MCP_HEADER_NAME_PATTERN)),
  Schema.String.check(Schema.isMaxLength(16_384)),
).check(Schema.isMaxProperties(64));

const ProviderMcpUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https?:\/\//iu),
);

const ProviderMcpStdioServerConfig = Schema.Struct({
  transport: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(Schema.isMaxLength(64)),
  env: ProviderMcpEnv,
});

export const ProviderMcpServerConfig = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("http"),
    url: ProviderMcpUrl,
    headers: ProviderMcpHeaders,
  }),
  ProviderMcpStdioServerConfig,
]);
export type ProviderMcpServerConfig = typeof ProviderMcpServerConfig.Type;

export const ProviderMcpAddInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ProviderMcpNewServerName,
  server: ProviderMcpServerConfig,
});
export type ProviderMcpAddInput = typeof ProviderMcpAddInput.Type;

export const ProviderMcpServerInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ProviderMcpServerName,
});
export type ProviderMcpServerInput = typeof ProviderMcpServerInput.Type;

const ProviderMcpSignInFlowId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProviderMcpSignInState = Schema.Struct({
  flowId: ProviderMcpSignInFlowId,
  phase: Schema.Literals(["waiting", "succeeded"]),
  /** Where the user approves access; absent when the provider signed in on its own. */
  authorizationUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_192))),
});
export type ProviderMcpSignInState = typeof ProviderMcpSignInState.Type;

export const ProviderMcpCompleteSignInInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: ProviderMcpSignInFlowId,
  /** The address the browser could not load after approval, when it runs on another machine. */
  callbackUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type ProviderMcpCompleteSignInInput = typeof ProviderMcpCompleteSignInInput.Type;

/** What an edit starts from: stored header and variable values stay on the server. */
export const ProviderMcpServerSettings = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("http"),
    /** Without credentials, query, or fragment. */
    url: Schema.String.check(Schema.isMaxLength(2_048)),
    /** The stored address has credentials or a query `url` leaves out. */
    urlHasSecret: Schema.Boolean,
    headerNames: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
      Schema.isMaxLength(64),
    ),
  }),
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMaxLength(1_024)),
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(
      Schema.isMaxLength(64),
    ),
    envNames: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(
      Schema.isMaxLength(64),
    ),
  }),
]);
export type ProviderMcpServerSettings = typeof ProviderMcpServerSettings.Type;

export const ProviderMcpReadResult = Schema.Struct({ server: ProviderMcpServerSettings });
export type ProviderMcpReadResult = typeof ProviderMcpReadResult.Type;

/** An empty header or variable value keeps the stored one; a name left out is deleted. */
export const ProviderMcpServerEdit = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("http"),
    /** Absent keeps the stored address. */
    url: Schema.optionalKey(ProviderMcpUrl),
    headers: ProviderMcpHeaders,
  }),
  ProviderMcpStdioServerConfig,
]);
export type ProviderMcpServerEdit = typeof ProviderMcpServerEdit.Type;

export const ProviderMcpEditInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ProviderMcpServerName,
  server: ProviderMcpServerEdit,
});
export type ProviderMcpEditInput = typeof ProviderMcpEditInput.Type;

export const ProviderMcpSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ProviderMcpServerName,
  enabled: Schema.Boolean,
});
export type ProviderMcpSetEnabledInput = typeof ProviderMcpSetEnabledInput.Type;

export const ProviderMcpOperation = Schema.Literals([
  "list",
  "add",
  "remove",
  "signIn",
  "signOut",
  "read",
  "edit",
  "setEnabled",
]);
export type ProviderMcpOperation = typeof ProviderMcpOperation.Type;

export const ProviderMcpErrorReason = Schema.Literals([
  "instanceNotFound",
  "unsupported",
  "signInClosed",
  "providerFailed",
]);
export type ProviderMcpErrorReason = typeof ProviderMcpErrorReason.Type;

const FAILED_OPERATION_MESSAGES: Record<ProviderMcpOperation, string> = {
  list: "Could not read the provider's MCP servers.",
  add: "Could not add the MCP server.",
  remove: "Could not remove the MCP server.",
  signIn: "Could not sign in to the MCP server.",
  signOut: "Could not sign out of the MCP server.",
  read: "Could not read the MCP server's settings.",
  edit: "Could not change the MCP server.",
  setEnabled: "Could not turn the MCP server on or off.",
};

export class ProviderMcpError extends Schema.TaggedError<ProviderMcpError>()("ProviderMcpError", {
  operation: ProviderMcpOperation,
  instanceId: ProviderInstanceId,
  reason: ProviderMcpErrorReason,
  /** The provider's own one-line reason, such as a name already in use. */
  providerMessage: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROVIDER_MCP_MESSAGE_MAX_LENGTH)),
  ),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "instanceNotFound":
        return "This provider is no longer configured.";
      case "unsupported":
        return "This provider does not manage MCP servers.";
      case "signInClosed":
        return "This sign-in is no longer open. Start it again.";
      case "providerFailed":
        return this.providerMessage ?? FAILED_OPERATION_MESSAGES[this.operation];
    }
  }
}

/** One bounded line of a provider's own error text, or nothing when it printed none. */
export function boundedProviderMcpMessage(text: string | null | undefined) {
  const line = text
    ?.split(/\r?\n/u)
    .map((part) => part.trim())
    .findLast((part) => part.length > 0);
  if (!line) return undefined;
  return line.length > PROVIDER_MCP_MESSAGE_MAX_LENGTH
    ? `${line.slice(0, PROVIDER_MCP_MESSAGE_MAX_LENGTH - 1)}…`
    : line;
}

/** A remote server's address with any credentials, query, or fragment left out. */
export function displayProviderMcpUrl(url: string) {
  try {
    const parsed = new URL(url);
    const target = `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
    return target.slice(0, PROVIDER_MCP_TARGET_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

/** A local server's command line, shortened to fit a row. */
export function displayProviderMcpCommand(command: string, args: ReadonlyArray<string>) {
  const line = [command, ...args].join(" ").trim();
  if (!line) return undefined;
  return line.length > PROVIDER_MCP_TARGET_MAX_LENGTH
    ? `${line.slice(0, PROVIDER_MCP_TARGET_MAX_LENGTH - 1)}…`
    : line;
}

/** A stored server as the edit form starts from it, with every header and variable value left out. */
export function providerMcpServerSettings(
  stored: ProviderMcpServerConfig,
): ProviderMcpServerSettings {
  if (stored.transport === "stdio") {
    return {
      transport: "stdio",
      command: stored.command,
      args: stored.args,
      envNames: Object.keys(stored.env),
    };
  }
  const parsed = URL.canParse(stored.url) ? new URL(stored.url) : undefined;
  const urlHasSecret =
    parsed === undefined ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "";
  return {
    transport: "http",
    url: urlHasSecret ? (displayProviderMcpUrl(stored.url) ?? "") : stored.url,
    urlHasSecret,
    headerNames: Object.keys(stored.headers),
  };
}

/**
 * The server an edit asks for, with each empty value and a missing address taken from the stored
 * server. A value the edit keeps but the stored server never had is reported by name.
 */
export function resolveProviderMcpServerEdit(
  stored: ProviderMcpServerConfig,
  edit: ProviderMcpServerEdit,
): { readonly server: ProviderMcpServerConfig } | { readonly missing: string } {
  const keep = (
    values: Readonly<Record<string, string>>,
    storedValues: Readonly<Record<string, string>>,
  ): Record<string, string> | string => {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const kept = value === "" ? storedValues[name] : value;
      if (kept === undefined) return name;
      resolved[name] = kept;
    }
    return resolved;
  };
  if (edit.transport === "stdio") {
    const env = keep(edit.env, stored.transport === "stdio" ? stored.env : {});
    return typeof env === "string" ? { missing: env } : { server: { ...edit, env } };
  }
  const url = edit.url ?? (stored.transport === "http" ? stored.url : undefined);
  if (url === undefined) return { missing: "URL" };
  const headers = keep(edit.headers, stored.transport === "http" ? stored.headers : {});
  return typeof headers === "string"
    ? { missing: headers }
    : { server: { transport: "http", url, headers } };
}
