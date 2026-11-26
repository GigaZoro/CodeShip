import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { resolvePackagedCodexMetadataBinary } from "../../textGeneration/packagedCodexMetadata.ts";
import { runClaudeCli } from "../../provider/Drivers/ClaudeExecutable.ts";

const encodeTomlString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

class ClaudeGuestSandboxUnavailable extends Data.TaggedError("ClaudeGuestSandboxUnavailable") {
  override readonly message =
    "Claude analysis-only guests require the supported macOS read-only sandbox.";
}

export interface ClaudeGuestSandbox {
  readonly wrap: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd?: string;
  }) => { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };
}

export const supportsClaudeGuestAnalysis = (platform: NodeJS.Platform) => platform === "darwin";

export const makeClaudeGuestSandbox = Effect.fn("ClaudeGuestSandbox.make")(function* () {
  const platform = yield* HostProcess.Platform;
  if (!supportsClaudeGuestAnalysis(platform)) return yield* new ClaudeGuestSandboxUnavailable();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const host = yield* HostProcess.Environment;
  const searchPath = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const workspace = yield* HostProcess.WorkingDirectory;
  const executable = yield* SpawnExecutableResolution;
  const binary =
    (yield* resolvePackagedCodexMetadataBinary()) ??
    executable("codex", platform, { PATH: searchPath }, "/");
  if (!binary || !path.isAbsolute(binary)) return yield* new ClaudeGuestSandboxUnavailable();
  const control = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-guest-" }),
  );
  const scratch = path.join(control, "scratch");
  yield* fs.makeDirectory(scratch, { mode: 0o700 });
  const config = path.join(scratch, "claude");
  yield* fs.makeDirectory(config, { mode: 0o700 });
  // The launcher owns its settings, proxy and control directory outside the guest's sole writable root.
  const env = {
    HOME: home,
    PATH: searchPath,
    USER: host.USER,
    LOGNAME: host.LOGNAME,
    LANG: host.LANG,
    CODEX_HOME: control,
    TMPDIR: control,
  };
  const version = yield* runClaudeCli({
    binaryPath: binary,
    args: ["--version"],
    environment: env,
    cwd: control,
  });
  // This release enforces the named permission profile and domain proxy together.
  if (version.code !== 0 || version.stdout.trim() !== "codex-cli 0.172.0")
    return yield* new ClaudeGuestSandboxUnavailable();
  yield* fs.writeFileString(
    path.join(control, "config.toml"),
    [
      "[features]",
      "network_proxy = true",
      "[permissions.analysis]",
      'extends = ":read-only"',
      // Codex grants access to the host preferences daemon only for unrestricted reads.
      "[permissions.analysis.filesystem]",
      `${encodeTomlString(path.join(control, "config.toml"))} = "deny"`,
      `${encodeTomlString(scratch)} = "write"`,
      "[permissions.analysis.network]",
      "enabled = true",
      'mode = "full"',
      "allow_upstream_proxy = false",
      "allow_local_binding = false",
      "dangerously_allow_all_unix_sockets = false",
      "unix_sockets = {}",
      "[permissions.analysis.network.domains]",
      '"api.anthropic.com" = "allow"',
      "",
    ].join("\n"),
  );
  return {
    wrap: (input) => ({
      command: binary,
      cwd: control,
      env,
      args: [
        "sandbox",
        "--permissions-profile",
        "analysis",
        "-C",
        control,
        "--",
        "/usr/bin/env",
        "-C",
        path.resolve(workspace, input.cwd ?? "."),
        `TMPDIR=${scratch}`,
        `CLAUDE_CONFIG_DIR=${config}`,
        // An empty override selects the machine's default keychain service even with a private config directory.
        `CLAUDE_SECURESTORAGE_CONFIG_DIR=${input.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? input.env.CLAUDE_CONFIG_DIR ?? ""}`,
        input.command,
        ...input.args,
      ],
    }),
  } satisfies ClaudeGuestSandbox;
});
