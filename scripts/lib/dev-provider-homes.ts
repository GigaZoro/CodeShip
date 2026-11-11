import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Provider logins use single-use rotating refresh tokens: two processes refreshing one login sign
 * the account out, so a dev server must not share one with the real app. Each variable is the
 * provider's own switch for the folder holding its login; Claude and Codex key their keychain
 * item to that folder too. Antigravity profiles already live in the state directory.
 */
export const DEV_PROVIDER_HOME_DIRECTORIES = {
  CLAUDE_CONFIG_DIR: "claude",
  CODEX_HOME: "codex",
  GROK_HOME: "grok",
  PI_CODING_AGENT_DIR: "pi",
} as const;

export type DevProviderHomeVariable = keyof typeof DEV_PROVIDER_HOME_DIRECTORIES;

export const DEV_PROVIDER_HOME_VARIABLES = Object.keys(
  DEV_PROVIDER_HOME_DIRECTORIES,
) as ReadonlyArray<DevProviderHomeVariable>;

// A machine-wide Claude token replaces the saved login and is handed to the default instance.
const REAL_LOGIN_VARIABLES = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;

// Codex keeps MCP sign-ins in the OS keychain by server name, shared by every CODEX_HOME. The file
// store keeps them in the isolated home. Same flag as `privateMcpSignInArgs` in the server.
const CODEX_FILE_MCP_SIGN_IN_ARGS = `"-c" "mcp_oauth_credentials_store=\\"file\\""`;
const CODEX_LAUNCH_ARGS_VARIABLE = "T3CODE_CODEX_LAUNCH_ARGS";

/** Points the server's provider homes at `root` and drops ambient logins; the real homes stay untouched. */
export function isolateProviderHomes(
  env: NodeJS.ProcessEnv,
  root: string,
  join: (...segments: ReadonlyArray<string>) => string,
): void {
  for (const variable of DEV_PROVIDER_HOME_VARIABLES) {
    env[variable] = join(root, DEV_PROVIDER_HOME_DIRECTORIES[variable]);
  }
  for (const variable of REAL_LOGIN_VARIABLES) {
    delete env[variable];
  }
  env[CODEX_LAUNCH_ARGS_VARIABLE] = [
    env[CODEX_LAUNCH_ARGS_VARIABLE]?.trim(),
    CODEX_FILE_MCP_SIGN_IN_ARGS,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

export interface SettingsProviderHome {
  readonly instanceId: string;
  readonly field: string;
  readonly path: string;
}

const decodeSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every provider home a stored `settings.json` names, from instance settings and instance
 * environment variables. An instance without one runs on the server's home variables.
 */
export function readSettingsProviderHomes(settings: unknown): ReadonlyArray<SettingsProviderHome> {
  if (!isRecord(settings) || !isRecord(settings.providerInstances)) return [];
  const homes: Array<SettingsProviderHome> = [];
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (!isRecord(instance)) continue;
    const config = isRecord(instance.config) ? instance.config : {};
    for (const field of ["homePath", "shadowHomePath"] as const) {
      const value = config[field];
      if (typeof value === "string" && value.trim() !== "") {
        homes.push({ instanceId, field, path: value.trim() });
      }
    }
    if (!Array.isArray(instance.environment)) continue;
    for (const variable of instance.environment) {
      if (
        isRecord(variable) &&
        typeof variable.name === "string" &&
        (DEV_PROVIDER_HOME_VARIABLES as ReadonlyArray<string>).includes(variable.name) &&
        typeof variable.value === "string" &&
        variable.value.trim() !== ""
      ) {
        homes.push({ instanceId, field: variable.name, path: variable.value.trim() });
      }
    }
  }
  return homes;
}

export class DevRunnerRealProviderHomesError extends Schema.TaggedError<DevRunnerRealProviderHomesError>()(
  "DevRunnerRealProviderHomesError",
  {
    settingsPath: Schema.String,
    homes: Schema.Array(
      Schema.Struct({ instanceId: Schema.String, field: Schema.String, path: Schema.String }),
    ),
  },
) {
  override get message(): string {
    const lines = this.homes.map((home) => `  ${home.instanceId}: ${home.field} = ${home.path}`);
    return [
      `${this.settingsPath} points provider instances at homes outside the dev server's own state:`,
      ...lines,
      "A dev server would refresh those logins next to the real app, and the loser of that race is signed out. Remove those fields (the instances then use the dev server's own provider homes), or start with --real-providers (T3CODE_DEV_REAL_PROVIDERS=1) if a test needs that login.",
    ].join("\n");
  }
}

/**
 * Refuses a dev home whose stored settings name a provider home outside it. Remapping would
 * rewrite settings the developer copied on purpose, and a login the settings name is a login the
 * developer chose, so the runner stops and says how to continue instead.
 */
export const assertSettingsKeepProviderHomesIsolated = Effect.fn(
  "dev-runner.assertSettingsKeepProviderHomesIsolated",
)(function* (baseDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const settingsPath = path.join(baseDir, "userdata", "settings.json");
  const contents = yield* fileSystem.readFileString(settingsPath).pipe(Effect.option);
  if (contents._tag === "None") return;
  // The server reports an unparsable file itself and starts on defaults, which name no homes.
  const parsed = yield* decodeSettingsJson(contents.value).pipe(Effect.option);
  if (parsed._tag === "None") return;
  const root = path.resolve(baseDir);
  const expandHome = (value: string) =>
    value === "~"
      ? home
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(home, value.slice(2))
        : value;
  const outside = readSettingsProviderHomes(parsed.value).filter((entry) => {
    const relative = path.relative(root, path.resolve(expandHome(entry.path)));
    return relative.startsWith("..") || path.isAbsolute(relative);
  });
  if (outside.length > 0) {
    return yield* new DevRunnerRealProviderHomesError({ settingsPath, homes: outside });
  }
});
