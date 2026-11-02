import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudePluginCommandMessage, makeClaudePluginManagement } from "./ClaudePlugins.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
// The fake CLI is a POSIX shell script.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

/** Answers like `claude plugin … --json` and records each argument list. */
const writeFakeClaude = Effect.fn(function* (directory: string, installPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = JSON.stringify({
    installed: [
      { id: "kit@official", version: "1.2.0", scope: "user", enabled: false, installPath },
      { id: "github@synced", version: "unknown", scope: "synced", enabled: true },
    ],
    available: [
      {
        pluginId: "kit@official",
        name: "kit",
        marketplaceName: "official",
        description: "Listed again by Claude",
      },
      {
        pluginId: "review@directory",
        name: "review",
        marketplaceName: "directory",
        description: "Reviews code",
        installCount: 1200,
        version: "2.0.0",
      },
    ],
  });
  const script = path.join(directory, "claude");
  yield* fs.writeFileString(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${path.join(directory, "calls.log")}"`,
      'case "$*" in',
      `  "plugin list --json --available") printf '%s\\n' '${list}' ;;`,
      `  "plugin marketplace list --json") printf '%s\\n' '[{"name":"official"}]' ;;`,
      `  "plugin install missing@official --scope user --json") printf '%s\\n' '{"command":"install","outcome":"failed","message":"Plugin \\"missing\\" not found in marketplace \\"official\\""}'; exit 1 ;;`,
      `  *) printf '%s\\n' '{"command":"other","outcome":"ok","message":"Cloning…\\nSuccessfully added marketplace: team","marketplace":"team"}' ;;`,
      "esac",
    ].join("\n"),
  );
  yield* fs.chmod(script, 0o755);
  return script;
});

it.layer(NodeServices.layer)("makeClaudePluginManagement", (it) => {
  it.effect.skipIf(windowsHost)("reads the catalog and runs changes through `claude plugin`", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-plugins-" });
      const installPath = path.join(directory, "kit");
      yield* fs.makeDirectory(path.join(installPath, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(installPath, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "kit", description: "Team review kit" }),
      );
      const binaryPath = yield* writeFakeClaude(directory, installPath);
      const plugins = yield* makeClaudePluginManagement({
        instanceId,
        binaryPath,
        environment: {},
        cwd: directory,
      });

      const catalog = yield* plugins.catalog;
      assert.deepEqual(catalog.plugins, [
        {
          id: "kit@official",
          name: "kit",
          marketplace: "official",
          description: "Team review kit",
          version: "1.2.0",
          installed: true,
          enabled: false,
          removable: true,
        },
        {
          id: "github@synced",
          name: "github",
          marketplace: "synced",
          installed: true,
          enabled: true,
          removable: false,
        },
        {
          id: "review@directory",
          name: "review",
          marketplace: "directory",
          description: "Reviews code",
          version: "2.0.0",
          installCount: 1200,
          installed: false,
          enabled: false,
          removable: true,
        },
      ]);
      assert.deepEqual(
        catalog.marketplaces.map((marketplace) => marketplace.name),
        ["official", "directory"],
      );

      const missing = yield* plugins.install("missing@official").pipe(Effect.flip);
      assert.equal(missing.message, 'Plugin "missing" not found in marketplace "official"');
      yield* plugins.setEnabled("kit@official", true);
      yield* plugins.uninstall("kit@official");
      const added = yield* plugins.addMarketplace("acme/plugins");
      assert.equal(added.marketplace, "team");

      const calls = (yield* fs.readFileString(path.join(directory, "calls.log")))
        .trim()
        .split("\n")
        .toSorted();
      assert.deepEqual(calls, [
        "plugin enable kit@official --json",
        "plugin install missing@official --scope user --json",
        "plugin list --json --available",
        "plugin marketplace add acme/plugins --json",
        "plugin marketplace list --json",
        "plugin uninstall kit@official --keep-data --json",
      ]);
    }),
  );
});

it("claudePluginCommandMessage reads the last result line", () => {
  assert.deepEqual(
    claudePluginCommandMessage('noise\n{"outcome":"ok","message":"Cloning…\\nAdded team"}\n'),
    { ok: true, message: "Added team" },
  );
  assert.deepEqual(claudePluginCommandMessage("✘ not json"), { ok: false });
});
