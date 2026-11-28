import { assert, it } from "@effect/vitest";
import type { ModelSelection } from "@t3tools/contracts/modelSelection";
import {
  type ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "@t3tools/contracts/providerInstance";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";

import { makeCodexShellEnvironment } from "./codexShellEnvironment.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5" } satisfies ModelSelection;

/**
 * An app server whose `config/read` answers with `config` and `configRequirements/read` with
 * `requirements`, recording what it was asked.
 */
const answering = (
  config: unknown,
  environment?: ProviderInstanceEnvironment,
  requirements: unknown = null,
) => {
  const requests: Array<readonly [string, unknown]> = [];
  const client = {
    request: (method: string, payload: unknown) =>
      Effect.sync(() => {
        requests.push([method, payload]);
        return method === "config/read" ? { config, origins: {} } : { requirements };
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  return {
    requests,
    shellEnvironment: makeCodexShellEnvironment({
      instanceId,
      environment,
      openClient: Effect.succeed(client),
    }),
  };
};

const host = {
  PATH: "/usr/bin",
  home: "/home/me",
  LANG: "C",
  EDITOR: "vi",
  OPENAI_API_KEY: "key",
  gh_token: "token",
  MONKEY: "banana",
};

it.effect.each([
  [
    "keeps the host's variables but secret-looking ones and adds what it sets",
    "linux",
    host,
    // The shape Codex 0.156 answers with.
    {
      model: "gpt-5.4",
      shell_environment_policy: {
        inherit: "all",
        ignore_default_excludes: false,
        exclude: [],
        set: { NODE_OPTIONS: "--network-family-autoselection-attempt-timeout=2500" },
        include_only: [],
        experimental_use_profile: null,
      },
    },
    {
      PATH: "/usr/bin",
      home: "/home/me",
      LANG: "C",
      EDITOR: "vi",
      NODE_OPTIONS: "--network-family-autoselection-attempt-timeout=2500",
    },
  ],
  ["keeps the host's variables without a policy", "linux", host, { model: "gpt-5.4" }, host],
  [
    "keeps the host's variables for a policy that sets none",
    "linux",
    host,
    { shell_environment_policy: { set: null } },
    host,
  ],
  [
    "keeps only the core variables, whatever their case",
    "linux",
    host,
    { shell_environment_policy: { inherit: "core" } },
    { PATH: "/usr/bin", home: "/home/me", LANG: "C" },
  ],
  [
    "keeps only what it sets when it inherits none",
    "linux",
    host,
    { shell_environment_policy: { inherit: "none", set: { ONLY: "set" } } },
    { ONLY: "set" },
  ],
  [
    "removes what it excludes, ignoring case, before it sets",
    "linux",
    host,
    { shell_environment_policy: { exclude: ["ed*", "path"], set: { PATH: "/agent" } } },
    {
      home: "/home/me",
      LANG: "C",
      OPENAI_API_KEY: "key",
      gh_token: "token",
      MONKEY: "banana",
      PATH: "/agent",
    },
  ],
  [
    "keeps only what it includes, after it sets",
    "linux",
    host,
    {
      shell_environment_policy: {
        include_only: ["PATH", "LAN?", "NODE_*"],
        set: { NODE_OPTIONS: "--max-old-space-size=4096", DROPPED: "set" },
      },
    },
    { PATH: "/usr/bin", LANG: "C", NODE_OPTIONS: "--max-old-space-size=4096" },
  ],
  [
    "applies its filters as excludes and includes",
    "linux",
    host,
    {
      shell_environment_policy: {
        filters: { "*_API_KEY": "exclude", PATH: "include", "*KEY": "include" },
        set: { EXTRA_KEY: "set" },
      },
    },
    { PATH: "/usr/bin", MONKEY: "banana", EXTRA_KEY: "set" },
  ],
  [
    // A Kelvin sign's lowercase is k, and Codex's matcher compares lowercase characters.
    "compares pattern characters by their lowercase",
    "linux",
    { PATH: "/usr/bin", API_KEY: "kelvin" },
    { shell_environment_policy: { exclude: ["*key*"] } },
    { PATH: "/usr/bin" },
  ],
  [
    // Unicode 17 added these lowercases, which Codex's Rust has and Node 22's Unicode 16 lacks.
    "compares pattern characters by their Unicode 17 lowercase",
    "linux",
    { PATH: "/usr/bin", [String.fromCodePoint(0xa7ce)]: "pharyngeal", "\u{16EA0}": "beria" },
    { shell_environment_policy: { exclude: [String.fromCodePoint(0xa7cf), "\u{16EBB}"] } },
    { PATH: "/usr/bin" },
  ],
  [
    // ſ uppercases to S, but Codex compares core names in ASCII case only.
    "keeps only names that are core in ASCII case",
    "linux",
    { PATH: "/usr/bin", ſHELL: "long s" },
    { shell_environment_policy: { inherit: "core" } },
    { PATH: "/usr/bin" },
  ],
  [
    "never keeps Codex's launch context, inherited or set, whatever its case",
    "linux",
    { ...host, NODE_REPL_AUTH_TOKEN: "inherited", openai_identity_token_file: "/inherited" },
    {
      shell_environment_policy: {
        set: { OPENAI_FEDERATION_RULE_ID: "set", Openai_Workload_Identity_Context: "set" },
      },
    },
    host,
  ],
  [
    "never keeps an inherited Codex session's values, by their exact name on POSIX",
    "linux",
    {
      ...host,
      CODEX_THREAD_ID: "thread",
      CODEX_SESSION_ID: "session",
      CODEX_VERSION: "0.1.0",
      CODEX_PERMISSION_PROFILE: "profile",
      codex_thread_id: "another name on POSIX",
    },
    { shell_environment_policy: { set: { CODEX_VERSION: "set" } } },
    { ...host, codex_thread_id: "another name on POSIX" },
  ],
  [
    "never keeps an inherited Codex session's values in any spelling on Windows",
    "win32",
    { Path: "C:\\Windows", Codex_Thread_Id: "thread", codex_permission_profile: "profile" },
    { shell_environment_policy: { inherit: "all" } },
    { Path: "C:\\Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
  ],
  [
    "keeps Windows' core variables, replaces any spelling of what it sets and adds Codex's PATHEXT",
    "win32",
    { Path: "C:\\Windows", SystemRoot: "C:\\Windows", EDITOR: "notepad" },
    { shell_environment_policy: { inherit: "core", set: { PATH: "C:\\agent" } } },
    { SystemRoot: "C:\\Windows", PATH: "C:\\agent", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
  ],
  [
    "keeps a Windows PATHEXT in any spelling",
    "win32",
    { Path: "C:\\Windows", PathExt: ".EXE" },
    { shell_environment_policy: { inherit: "all" } },
    { Path: "C:\\Windows", PathExt: ".EXE" },
  ],
] as const)("Codex's shell commands in a folder %s", ([, platform, inherited, config, expected]) =>
  Effect.gen(function* () {
    const codex = answering(config);
    assert.deepEqual(
      yield* codex.shellEnvironment("/work/repo", inherited, modelSelection),
      expected,
    );
    assert.sameDeepMembers(codex.requests, [
      ["config/read", { cwd: "/work/repo", includeLayers: false }],
      ["configRequirements/read", undefined],
    ]);
  }).pipe(Effect.provideService(HostProcess.Platform, platform)),
);

it.effect.each([
  [
    "drops an inherited one, whatever its case, while the feature is off",
    { features: { code_mode: { enabled: true } } },
    null,
    { PATH: "/usr/bin" },
  ],
  [
    "sets it, past include_only, when the config turns the feature on",
    {
      features: { apply_patch_preserve_line_endings: true },
      shell_environment_policy: { include_only: ["PATH"] },
    },
    null,
    { PATH: "/usr/bin", CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "1" },
  ],
  [
    "sets it when a managed requirement pins the feature on",
    { features: { apply_patch_preserve_line_endings: false } },
    { featureRequirements: { apply_patch_preserve_line_endings: true } },
    { PATH: "/usr/bin", CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: "1" },
  ],
  [
    "drops it when a managed requirement pins the feature off",
    { features: { apply_patch_preserve_line_endings: true } },
    { featureRequirements: { apply_patch_preserve_line_endings: false } },
    { PATH: "/usr/bin" },
  ],
] as const)("Codex's apply_patch line-endings switch %s", ([, config, requirements, expected]) =>
  Effect.gen(function* () {
    const codex = answering(config, undefined, requirements);
    assert.deepEqual(
      yield* codex.shellEnvironment(
        "/work/repo",
        {
          PATH: "/usr/bin",
          codex_apply_patch_preserve_line_endings: "0",
        },
        modelSelection,
      ),
      expected,
    );
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("applies its policy to its account's variables too", () =>
  Effect.gen(function* () {
    const codex = answering({ shell_environment_policy: { inherit: "core", exclude: ["path"] } }, [
      { name: "LANG", value: "uk_UA.UTF-8", sensitive: false },
      { name: "PATH", value: "/account/bin", sensitive: false },
    ]);
    assert.deepEqual(yield* codex.shellEnvironment("/work/repo", host, modelSelection), {
      home: "/home/me",
      LANG: "uk_UA.UTF-8",
    });
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("refuses a policy it cannot apply as Codex would", () =>
  Effect.gen(function* () {
    const codex = answering({ shell_environment_policy: { inherit: "login" } });
    const failure = yield* Effect.flip(codex.shellEnvironment("/work/repo", host, modelSelection));
    assert.include(failure.detail, "Codex could not read its config for '/work/repo'.");
  }),
);
