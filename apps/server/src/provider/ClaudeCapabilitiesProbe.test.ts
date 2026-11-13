// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";
import { CLAUDE_TERMS_REVIEW_MESSAGE } from "./Drivers/ClaudeHome.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
    onStderr: () => {},
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

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
          { HOME: dir, PATH: process.env.PATH },
          dir,
          false,
        ).pipe(Effect.flip);
        assert.deepStrictEqual({ _tag: error._tag, message: error.message }, expected);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
