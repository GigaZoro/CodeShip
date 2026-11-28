import {
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@t3tools/contracts/providerInstance";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { asciiUpperCase, overrideEnvironment } from "@t3tools/shared/shell";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ProviderDriverError } from "./Errors.ts";

const DRIVER = ProviderDriverKind.make("codex");

const Patterns = Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)));
const ShellEnvironmentPolicy = Schema.Struct({
  inherit: Schema.optionalKey(Schema.NullOr(Schema.Literals(["all", "core", "none"]))),
  ignore_default_excludes: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  exclude: Patterns,
  set: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  include_only: Patterns,
  filters: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Literals(["include", "exclude"]))),
  ),
});
type ShellEnvironmentPolicy = typeof ShellEnvironmentPolicy.Type;
const decodeShellEnvironmentConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    shell_environment_policy: Schema.optionalKey(Schema.NullOr(ShellEnvironmentPolicy)),
    features: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({ apply_patch_preserve_line_endings: Schema.optionalKey(Schema.Boolean) }),
      ),
    ),
  }),
);

// Codex's own lists, in codex-rs/protocol/src/shell_environment.rs.
const POSIX_CORE = [
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "USER",
];
const WINDOWS_CORE = [
  "PATH",
  "PATHEXT",
  "SHELL",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "USERNAME",
  "USERDOMAIN",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "POWERSHELL",
  "PWSH",
];
const DEFAULT_EXCLUDES = ["*KEY*", "*SECRET*", "*TOKEN*"];
// Codex's apply_patch keeps a file's line endings only when this variable is "1", which Codex
// sets from its apply_patch_preserve_line_endings feature.
const LINE_ENDINGS_SWITCH = "CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS";
// Dropped in any ASCII case whatever the policy gave: Codex's launch context, which its commands
// never get, and the line-endings switch, which Codex sets itself.
const ALWAYS_DROPPED = new Set([
  "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
  "NODE_REPL_AUTH_TOKEN",
  "OPENAI_FEDERATION_RULE_ID",
  "OPENAI_IDENTITY_TOKEN_FILE",
  "OPENAI_WORKLOAD_IDENTITY_CONTEXT",
  LINE_ENDINGS_SWITCH,
]);
// Codex replaces or removes these with its own session's values, so an inherited one never
// reaches its commands; T3.CodeShip's command runs in no Codex session and gets none.
const SESSION_VARIABLES = new Set([
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_VERSION",
  "CODEX_PERMISSION_PROFILE",
]);
const WINDOWS_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
// Codex 0.156 lowercases with Rust's Unicode 17 data; these lowercases are new in Unicode 17, so
// a Unicode 16 runtime (Node 22) leaves them as they are.
const UNICODE_17_LOWERCASE = new Map(
  (
    [
      [0xa7ce, 0xa7cf],
      [0xa7d2, 0xa7d3],
      [0xa7d4, 0xa7d5],
      // Beria Erfe's capitals.
      ...Array.from({ length: 25 }, (_, index) => [0x16ea0 + index, 0x16ebb + index] as const),
    ] as const
  ).map(([upper, lower]) => [String.fromCodePoint(upper), String.fromCodePoint(lower)] as const),
);

/** Each character's lowercase, which is how Codex's wildmatch patterns compare characters. */
const lowercaseCharacters = (text: string) =>
  Array.from(text, (character) => UNICODE_17_LOWERCASE.get(character) ?? character.toLowerCase());

/** Codex's patterns: `*` and `?` over the whole name. */
const matchesAny = (patterns: ReadonlyArray<string>) => {
  const compiled = patterns.map(lowercaseCharacters);
  return (name: string) => {
    const characters = lowercaseCharacters(name);
    return compiled.some((pattern) => {
      let at = 0;
      let star = -1;
      let resume = 0;
      for (let next = 0; next < characters.length;) {
        if (pattern[at] === "*") {
          star = at++;
          resume = next;
        } else if (
          at < pattern.length &&
          (pattern[at] === "?" || pattern[at] === characters[next])
        ) {
          at++;
          next++;
        } else if (star === -1) {
          return false;
        } else {
          at = star + 1;
          next = ++resume;
        }
      }
      while (pattern[at] === "*") at++;
      return at === pattern.length;
    });
  };
};

/** What Codex's shell tool gives a command that would inherit `inherited`, step by step as Codex does. */
const codexCommandEnvironment = (
  inherited: Readonly<NodeJS.ProcessEnv>,
  policy: ShellEnvironmentPolicy,
  platform: NodeJS.Platform,
  preserveLineEndings: boolean,
) => {
  const filters = Object.entries(policy.filters ?? {});
  const patternsFor = (action: "include" | "exclude") =>
    filters.filter((filter) => filter[1] === action).map(([pattern]) => pattern);
  // Codex refuses `filters` beside the legacy lists, so one of the two is set.
  const exclude = policy.filters ? patternsFor("exclude") : (policy.exclude ?? []);
  const includeOnly = policy.filters ? patternsFor("include") : (policy.include_only ?? []);
  const core = new Set(platform === "win32" ? WINDOWS_CORE : POSIX_CORE);
  const inherit = policy.inherit ?? "all";
  const excluded = matchesAny([
    ...(policy.ignore_default_excludes === false ? DEFAULT_EXCLUDES : []),
    ...exclude,
  ]);
  const kept = Object.entries(inherited).filter(
    ([name]) =>
      (inherit === "all" || (inherit === "core" && core.has(asciiUpperCase(name)))) &&
      !excluded(name),
  );
  const included = includeOnly.length === 0 ? () => true : matchesAny(includeOnly);
  const environment = Object.fromEntries(
    Object.entries(
      overrideEnvironment(Object.fromEntries(kept), policy.set ?? {}, platform),
    ).filter(
      ([name]) =>
        included(name) &&
        !ALWAYS_DROPPED.has(asciiUpperCase(name)) &&
        !SESSION_VARIABLES.has(platform === "win32" ? asciiUpperCase(name) : name),
    ),
  );
  const needsPathExt =
    platform === "win32" &&
    !Object.keys(environment).some((name) => asciiUpperCase(name) === "PATHEXT");
  return {
    ...environment,
    ...(needsPathExt ? { PATHEXT: WINDOWS_DEFAULT_PATHEXT } : {}),
    ...(preserveLineEndings ? { [LINE_ENDINGS_SWITCH]: "1" } : {}),
  };
};

/**
 * The environment Codex's shell commands get in a folder: its account's variables, then
 * `shell_environment_policy` and the apply_patch feature as Codex layers its config there (system,
 * user, trusted project config and launch arguments), where a managed requirement pins a feature.
 */
export function makeCodexShellEnvironment<E>(input: {
  readonly instanceId: ProviderInstanceId;
  readonly environment: ProviderInstanceEnvironment | undefined;
  readonly openClient: Effect.Effect<CodexClient.CodexAppServerClient["Service"], E, Scope.Scope>;
}): NonNullable<ProviderInstance["shellEnvironment"]> {
  return (cwd, inherited) =>
    input.openClient.pipe(
      Effect.flatMap((client) =>
        Effect.all(
          [
            client.request("config/read", { cwd, includeLayers: false }),
            client.request("configRequirements/read", undefined),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
      Effect.timeout("20 seconds"),
      Effect.flatMap(([read, { requirements }]) =>
        decodeShellEnvironmentConfig(read.config).pipe(
          Effect.map((config) => ({
            policy: config.shell_environment_policy ?? {},
            preserveLineEndings:
              requirements?.featureRequirements?.apply_patch_preserve_line_endings ??
              config.features?.apply_patch_preserve_line_endings ??
              false,
          })),
        ),
      ),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: `Codex could not read its config for '${cwd}'.`,
            cause,
          }),
      ),
      Effect.flatMap(({ policy, preserveLineEndings }) =>
        Effect.all([
          mergeProviderInstanceEnvironment(input.environment, inherited),
          HostProcess.Platform,
        ]).pipe(
          Effect.map(([launched, platform]) =>
            codexCommandEnvironment(launched, policy, platform, preserveLineEndings),
          ),
        ),
      ),
    );
}
