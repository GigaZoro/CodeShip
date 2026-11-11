// @effect-diagnostics-next-line nodeBuiltinImport:off -- Claude names its Keychain item after a synchronous hash of the config folder.
import * as NodeCrypto from "node:crypto";

import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ClaudeSettings } from "@t3tools/contracts";
import { claudeOAuthTokenExpiry } from "./claudeOAuthToken.ts";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
// Claude Code's Keychain item is readable by `security` without a prompt; a dialog still ends here.
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;
const CREDENTIALS_FILE = ".credentials.json";

/** Only the refresh token's expiry is decoded: the token strings in the same document are never read. */
const LoginCredentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      refreshTokenExpiresAt: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeLoginCredentials = Schema.decodeUnknownOption(Schema.fromJsonString(LoginCredentials));

/**
 * The Keychain service Claude Code uses for a config folder. The default folder has no suffix; a
 * folder set through `CLAUDE_CONFIG_DIR` adds the first 8 hex characters of the SHA-256 of that value.
 */
export const claudeKeychainService = (claudeConfigDir: string | undefined): string => {
  const configured = claudeConfigDir?.trim();
  if (!configured) return KEYCHAIN_SERVICE;
  const digest = NodeCrypto.createHash("sha256")
    .update(configured.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${digest}`;
};

/** Parses a saved login document and keeps only when its refresh token stops working. */
export const parseClaudeLoginExpiry = (document: string): string | undefined => {
  const expiresAt = Option.getOrUndefined(decodeLoginCredentials(document))?.claudeAiOauth
    ?.refreshTokenExpiresAt;
  if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt <= 0) return undefined;
  return Option.match(DateTime.make(expiresAt), {
    onNone: () => undefined,
    onSome: DateTime.formatIso,
  });
};

const readKeychainItem = Effect.fn("claudeLoginExpiry.readKeychainItem")(function* (
  service: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // `-w` prints the secret; it is parsed in memory and never logged, returned or stored.
  const command = ChildProcess.make("security", ["find-generic-password", "-s", service, "-w"]);
  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(command);
    const [stdout, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stdout), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    return exitCode === 0 ? Option.some(stdout) : Option.none<string>();
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(KEYCHAIN_READ_TIMEOUT_MS),
    Effect.map(Option.flatten),
  );
});

const readCredentialsFile = Effect.fn("claudeLoginExpiry.readCredentialsFile")(function* (
  configDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(configDir, CREDENTIALS_FILE));
});

/**
 * When a Claude subscription login lapses, from the saved login itself. Never runs `claude`, which
 * could refresh the login and race other processes. Unknown (undefined) when the login is
 * missing, unreadable, held by a manually supplied token, or the read times out.
 */
export const readClaudeLoginExpiry = Effect.fn("claudeLoginExpiry.read")(function* (input: {
  readonly configDir: string;
  /** The `CLAUDE_CONFIG_DIR` Claude runs with, undefined for the default folder. */
  readonly claudeConfigDirEnv: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly tokenMetadata?: ClaudeSettings["oauthToken"];
}): Effect.fn.Return<
  string | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const token = input.environment.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (token) return claudeOAuthTokenExpiry(token, input.tokenMetadata);
  if ((yield* HostProcess.Platform) === "darwin") {
    const stored = yield* readKeychainItem(claudeKeychainService(input.claudeConfigDirEnv)).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    // The Keychain holds the login Claude is using; a file left by an older login must not outvote it.
    if (Option.isSome(stored)) return parseClaudeLoginExpiry(stored.value);
  }
  const document = yield* readCredentialsFile(input.configDir).pipe(Effect.option);
  return Option.isSome(document) ? parseClaudeLoginExpiry(document.value) : undefined;
});
