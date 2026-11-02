import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { grokPluginFailureMessage, makeGrokPluginManagement } from "./plugins.ts";

const instanceId = ProviderInstanceId.make("grok");
// The fake CLI is a POSIX shell script.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

/** Answers like `grok plugin …` and records each argument list. */
const writeFakeGrok = Effect.fn(function* (directory: string, installPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const list = JSON.stringify([
    { status: "installed", name: "neon", version: "1.0.0", marketplace: "xAI Official" },
    { status: "installed", name: "neon", marketplace: "claude-plugins-official" },
    { status: "installed", name: "kit", version: "2.0.0", marketplace: null, path: installPath },
    {
      status: "available",
      name: "vercel",
      version: null,
      description: "Deploys to Vercel",
      marketplace: "xAI Official",
    },
  ]);
  const script = path.join(directory, "grok");
  yield* fs.writeFileString(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${path.join(directory, "calls.log")}"`,
      'case "$*" in',
      `  "plugin list --json --available") printf '%s\\n' '${list}' ;;`,
      `  "plugin install missing@xAI Official --trust") printf '%s\\n' 'Error: No marketplace plugin named "missing" in any registered marketplace.' 'Install a local directory instead.' >&2; exit 1 ;;`,
      `  "plugin marketplace add acme/plugins") printf '%s\\n' 'Added marketplace source: Acme (https://github.com/acme/plugins.git)' ;;`,
      "  *) printf '%s\\n' 'Done' ;;",
      "esac",
    ].join("\n"),
  );
  yield* fs.chmod(script, 0o755);
  return script;
});

it.layer(NodeServices.layer)("makeGrokPluginManagement", (it) => {
  it.effect.skipIf(windowsHost)("reads the catalog and runs changes through `grok plugin`", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-plugins-" });
      const grokHome = path.join(directory, "home");
      const installPath = path.join(directory, "kit");
      yield* fs.makeDirectory(path.join(installPath, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(installPath, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "kit", description: "Team review kit" }),
      );
      yield* fs.makeDirectory(grokHome);
      yield* fs.writeFileString(
        path.join(grokHome, "config.toml"),
        '[plugins]\nenabled = ["kit"]\ndisabled = [\n  "neon",\n]\n',
      );
      const binaryPath = yield* writeFakeGrok(directory, installPath);
      const plugins = yield* makeGrokPluginManagement({
        instanceId,
        binaryPath,
        environment: { GROK_HOME: grokHome },
        cwd: directory,
      });

      const catalog = yield* plugins.catalog;
      assert.deepEqual(catalog.plugins, [
        {
          id: "neon@xAI Official",
          name: "neon",
          marketplace: "xAI Official",
          version: "1.0.0",
          installed: true,
          enabled: false,
          removable: true,
        },
        {
          id: "neon@claude-plugins-official",
          name: "neon",
          marketplace: "claude-plugins-official",
          installed: true,
          enabled: false,
          removable: true,
        },
        {
          id: "kit",
          name: "kit",
          marketplace: "",
          description: "Team review kit",
          version: "2.0.0",
          installed: true,
          enabled: true,
          removable: true,
        },
        {
          id: "vercel@xAI Official",
          name: "vercel",
          marketplace: "xAI Official",
          description: "Deploys to Vercel",
          installed: false,
          enabled: false,
          removable: true,
        },
      ]);
      assert.deepEqual(catalog.marketplaces, [
        { name: "xAI Official" },
        { name: "claude-plugins-official" },
      ]);
      assert.deepEqual(catalog.warnings, []);

      const missing = yield* plugins.install("missing@xAI Official").pipe(Effect.flip);
      assert.equal(
        missing.message,
        'No marketplace plugin named "missing" in any registered marketplace.',
      );
      yield* plugins.install("vercel@xAI Official");
      yield* plugins.setEnabled("neon@xAI Official", true);
      yield* plugins.uninstall("kit");
      const added = yield* plugins.addMarketplace("acme/plugins");
      assert.equal(added.marketplace, "Acme");

      const calls = (yield* fs.readFileString(path.join(directory, "calls.log")))
        .trim()
        .split("\n")
        .toSorted();
      assert.deepEqual(calls, [
        "plugin enable neon",
        "plugin install missing@xAI Official --trust",
        "plugin install vercel@xAI Official --trust",
        "plugin list --json --available",
        "plugin marketplace add acme/plugins",
        "plugin uninstall kit --keep-data",
      ]);

      yield* fs.writeFileString(path.join(grokHome, "config.toml"), "[plugins\n");
      const unreadable = yield* plugins.catalog;
      assert.isTrue(unreadable.plugins.every((plugin) => plugin.enabled === plugin.installed));
      assert.equal(unreadable.warnings.length, 1);
    }),
  );
});

it("grokPluginFailureMessage prefers Grok's error line", () => {
  assert.equal(
    grokPluginFailureMessage({
      stdout: "",
      stderr:
        "Error: git ls-remote failed: authentication required\nNot adding it: re-run with --force\n",
    }),
    "git ls-remote failed: authentication required",
  );
  assert.equal(
    grokPluginFailureMessage({
      stdout: "Plugins can run hooks, so installation needs explicit trust.\n",
      stderr: "",
    }),
    "Plugins can run hooks, so installation needs explicit trust.",
  );
  assert.equal(grokPluginFailureMessage({ stdout: "", stderr: "\n" }), undefined);
});
