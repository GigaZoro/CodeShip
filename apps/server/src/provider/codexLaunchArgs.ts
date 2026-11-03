import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

// Codex keeps MCP sign-ins in the keychain by server, so every account shares them; the file store
// keeps an account's own in `.credentials.json` in its CODEX_HOME.
const PRIVATE_MCP_SIGN_IN_ARGS = ["-c", 'mcp_oauth_credentials_store="file"'] as const;

export const privateMcpSignInArgs = (privateSignIns: boolean): ReadonlyArray<string> =>
  privateSignIns ? PRIVATE_MCP_SIGN_IN_ARGS : [];

/** Launch args, as one string, that keep this account's MCP sign-ins to itself when asked. */
export const withPrivateMcpSignIns = (launchArgs: string, privateSignIns: boolean) =>
  privateSignIns
    ? [launchArgs.trim(), ...PRIVATE_MCP_SIGN_IN_ARGS.map((arg) => JSON.stringify(arg))]
        .filter((arg) => arg !== "")
        .join(" ")
    : launchArgs;

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
