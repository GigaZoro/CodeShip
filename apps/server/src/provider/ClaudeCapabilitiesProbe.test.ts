// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  claudeWorkspaceFunding,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
  spawnClaudeProbeThroughEnv,
} from "./ClaudeProvider.ts";
import { CLAUDE_TERMS_REVIEW_MESSAGE } from "./Drivers/ClaudeHome.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const hostPath = process.env.PATH;

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
    onStderr: () => {},
    onSpawnedStderr: () => {},
    spawnVia: undefined,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

// A shell trampoline would not do: dash drops the exported function, and the launcher exits 127.
it.live.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "starts a Bash launcher that calls an exported function in the probe's workspace",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      yield* fileSystem.writeFileString(`${workspace}/claude`, '#!/bin/bash\nt3_launch "$@"\n');
      yield* fileSystem.chmod(`${workspace}/claude`, 0o755);
      const child = spawnClaudeProbeThroughEnv({
        command: "claude",
        args: ["--probe"],
        cwd: workspace,
        env: { PATH: `.:${hostPath}`, "BASH_FUNC_t3_launch%%": '() { echo "$PWD $@"; }' },
        // @effect-diagnostics-next-line abortControllerInEffect:off - The launcher exits on its own.
        signal: new AbortController().signal,
      });
      assert.deepEqual(child.spawnargs.slice(0, 3), ["/usr/bin/env", "-C", workspace]);
      const output = yield* Effect.promise(() => child.stdout.setEncoding("utf8").toArray());
      assert.equal(output.join(""), `${workspace} --probe\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("resolves the Windows Claude SDK probe launcher from its child directory", () =>
  Effect.gen(function* () {
    const cwd = "C:\\checkout";
    const expected = `${cwd}\\tools\\claude.exe`;
    const query = vi.mocked(claudeQuery).mockImplementationOnce(() => {
      throw new Error("probe fixture");
    });
    yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: "tools" },
      cwd,
      false,
    ).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, _env, directory) =>
        directory === cwd ? expected : "C:\\server\\tools\\claude.exe",
      ),
      Effect.flip,
    );
    assert.equal(query.mock.lastCall?.[0].options?.cwd, cwd);
    assert.equal(query.mock.lastCall?.[0].options?.pathToClaudeCodeExecutable, expected);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("verifies Claude's funding for the actual destination and active login", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped();
    const homePath = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(cwd, ".claude"));
    const settings = yield* decodeClaudeSettings({ enabled: true, homePath });
    const provider = {
      instanceId: ProviderInstanceId.make("work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      status: "ready",
      version: "1",
      checkedAt: "2026-11-26T12:00:00Z",
      auth: { status: "authenticated", email: "member@example.test" },
      models: [],
      slashCommands: [],
      skills: [],
    } as const satisfies ServerProvider;
    let probes = 0;
    const funding = (overage: boolean | null, email: string = provider.auth.email) =>
      claudeWorkspaceFunding(
        settings,
        { HOME: homePath },
        { provider, cwd },
        (_settings, _environment, directory, _usage, launch) => {
          probes++;
          assert.equal(directory, cwd);
          assert.deepEqual(launch?.settingSources, ["user", "project", "local"]);
          return Effect.succeed({
            email,
            subscriptionType: "max",
            tokenSource: "claude.ai",
            apiKeySource: "none",
            apiProvider: "firstParty",
            slashCommands: [],
            usage: {
              rate_limits_available: true,
              rate_limits:
                overage === null
                  ? {}
                  : {
                      extra_usage: {
                        is_enabled: overage,
                        monthly_limit: null,
                        used_credits: null,
                        utilization: null,
                      },
                    },
            },
          });
        },
      );
    assert.equal(yield* funding(false), "included");
    assert.equal(yield* funding(true), "metered");
    assert.equal(yield* funding(null), "unknown");
    assert.equal(yield* funding(false, "other@example.test"), "unknown");
    const filename = path.join(cwd, ".claude", "settings.local.json");
    for (const local of [
      { env: { ANTHROPIC_BASE_URL: "https://gateway.example.test" } },
      { env: { ANTHROPIC_API_KEY: "test-fixture" } },
      { apiKeyHelper: "example" },
    ]) {
      yield* fs.writeFileString(filename, JSON.stringify(local));
      assert.equal(yield* funding(false), "unknown");
    }
    assert.equal(probes, 4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "when Claude refuses to start",
  () => {
    it.effect.each([
      {
        scenario: "names pending Consumer Terms until they are reviewed",
        stderr: () =>
          "[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n",
        expected: {
          _tag: "ClaudeTermsReviewRequiredError",
          message: CLAUDE_TERMS_REVIEW_MESSAGE,
        },
      },
      {
        scenario: "names the first line Claude printed, with paths and emails redacted",
        stderr: (home: string) =>
          `Invalid settings in ${home}/.claude/settings.json for ada@example.com: Unexpected token\n    at parse (cli.js:1:1)\n`,
        expected: {
          _tag: "ClaudeCapabilitiesProbeFailedError",
          message:
            "Claude Agent CLI failed while checking account status: Invalid settings in ~/.claude/settings.json for [email]: Unexpected token",
        },
      },
    ])("$scenario", ({ stderr, expected }) =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-refusal-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
        );
        const stderrPath = NodePath.join(dir, "stderr.txt");
        NodeFS.writeFileSync(stderrPath, stderr(dir));
        const cli = NodePath.join(dir, "claude");
        NodeFS.writeFileSync(cli, `#!/bin/sh\ncat '${stderrPath}' >&2\nexit 1\n`, {
          mode: 0o755,
        });
        const error = yield* probeClaudeCapabilities(
          yield* decodeClaudeSettings({ binaryPath: cli }),
          { HOME: dir, PATH: hostPath },
          dir,
          false,
        ).pipe(Effect.flip);
        assert.deepStrictEqual({ _tag: error._tag, message: error.message }, expected);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);

it.effect("keeps the probe subprocess alive while gateway model discovery can finish", () =>
  Effect.gen(function* () {
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          models: [{ value: "gateway/claude-relay", displayName: "Relay", description: "" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          new Promise((_, reject) => reject(new Error("usage unavailable"))),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped();
    // Claude Code also reads these from settings.json, which is where gateway users set them.
    yield* fileSystem.writeFileString(
      `${configDir}/settings.json`,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }),
    );
    const capabilities = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: (yield* HostProcess.Environment).PATH, CLAUDE_CONFIG_DIR: configDir },
    );
    assert.deepEqual(
      capabilities.models?.map((model) => model.value),
      ["gateway/claude-relay"],
    );
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("3 seconds");
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
