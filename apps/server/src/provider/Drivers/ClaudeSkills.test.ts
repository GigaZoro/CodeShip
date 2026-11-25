import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import { linkDirectory } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { beforeEach, vi } from "vite-plus/test";

import {
  discoverClaudeSkills,
  linkClaudeSharedSkills,
  readClaudeAutoUpdatesChannel,
  setClaudeSkillOverride,
} from "./ClaudeSkills.ts";
import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

// The real resolver reads the managed settings of the machine running the test.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

// With the account's server-managed settings, the real resolver ignores the machine's own: the
// highest policy source present wins.
const useRealResolver = Effect.fn(function* () {
  const sdk = yield* Effect.promise(() =>
    vi.importActual<typeof ClaudeSdk>("@anthropic-ai/claude-agent-sdk"),
  );
  vi.mocked(ClaudeSdk.resolveSettings).mockImplementation(sdk.resolveSettings);
});

const POLICY_HELPER = { policyHelper: { path: "/opt/org/policy-helper" } };

const writeSkill = Effect.fn(function* (
  skillsDir: string,
  directoryName: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(skillsDir, directoryName);
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

// Keeps the developer's own ~/.agents/skills out of every case.
const isolatedHome = Layer.succeed(HostProcess.HomeDirectory, "/nonexistent-t3-home");

// Windows separates CLAUDE_CODE_PLUGIN_DIRS with ";" and takes the managed folder from the
// environment, so a fixture controls both.
const discoverOnWindows = (...input: Parameters<typeof discoverClaudeSkills>) =>
  discoverClaudeSkills(...input).pipe(Effect.provideService(HostProcess.Platform, "win32"));

it.layer(Layer.mergeAll(NodeServices.layer, isolatedHome))("discoverClaudeSkills", (it) => {
  it.effect("discovers enabled plugin skills with manifest names and ignores skill overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const plugin = path.join(configDir, "plugins", "cache", "shop", "plugin", "1.0.0");
      const disabled = path.join(configDir, "plugins", "disabled");
      yield* writeSkill(path.join(disabled, "skills"), "hidden", "# Hidden");
      yield* writeSkill(path.join(plugin, "skills"), "plain", "# Plain");
      yield* writeSkill(
        path.join(plugin, "engineering"),
        "review",
        "---\nname: review-alias\ndescription: Review changes.\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
      );
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        '{"name":"manifest-plugin","skills":["./engineering/review"]}',
      );
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [{ scope: "user", installPath: plugin }],
            "disabled@shop": [{ scope: "user", installPath: disabled }],
            "unconfigured@shop": [{ scope: "user", installPath: disabled }],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"disabled@shop":false,"uninstalled@shop":true,"other@shop":["^1.0.0"]},"skillOverrides":{"manifest-plugin:plain":"off"}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(skills, [
        {
          name: "manifest-plugin:plain",
          path: path.join(plugin, "skills", "plain", "SKILL.md"),
          enabled: true,
          scope: "user",
        },
        {
          name: "manifest-plugin:review-alias",
          path: path.join(plugin, "engineering", "review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Review changes.",
          userInvocationOnly: true,
          userInvocable: false,
        },
      ]);
    }),
  );

  it.effect("merges plugin enablement and selects installs in native registry order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Project matching compares real paths; macOS tmpdir sits behind /var -> /private/var.
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" }),
      );
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const nestedWorkspace = path.join(workspace, "packages", "app");
      const aliasedWorkspace = path.join(tempDir, "aliased-workspace");
      const userInstall = path.join(configDir, "plugins", "user");
      const projectInstall = path.join(configDir, "plugins", "project");
      const localInstall = path.join(configDir, "plugins", "local");
      const managedInstall = path.join(configDir, "plugins", "managed");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(nestedWorkspace, { recursive: true });
      yield* linkDirectory(workspace, aliasedWorkspace);
      for (const install of [userInstall, projectInstall, localInstall, managedInstall]) {
        yield* writeSkill(path.join(install, "skills"), "review", "# Review");
      }
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "plugin@shop": [
              { scope: "project", projectPath: aliasedWorkspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "user", installPath: userInstall },
              { scope: "managed", installPath: managedInstall },
            ],
            "local@shop": [
              { scope: "local", projectPath: workspace, installPath: localInstall },
              { scope: "project", projectPath: workspace, installPath: projectInstall },
              { scope: "managed", installPath: path.join(configDir, "plugins", "missing") },
              { scope: "managed", installPath: managedInstall },
              { scope: "user", installPath: userInstall },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false}}',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{"enabledPlugins":{"plugin@shop":false,"local@shop":true,"other@shop":["^1.0.0"]}}',
      );
      const projectSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        projectSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")]],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace)).map((skill) => [
          skill.name,
          skill.scope,
          skill.path,
        ]),
        [["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")]],
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":false},"skillOverrides":{"invalid":"bogus"}}',
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, workspace),
        projectSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const localSettings = yield* discoverClaudeSkills({ homePath: configDir }, workspace);
      assert.deepEqual(
        localSettings.map((skill) => [skill.name, skill.scope, skill.path]),
        [
          ["local:review", "project", path.join(localInstall, "skills", "review", "SKILL.md")],
          ["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")],
        ],
      );
      // Windows keeps the local file in cwd, so a nested workspace never sees the root's.
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, nestedWorkspace),
        isWindowsHost
          ? localSettings.filter((skill) => skill.name === "plugin:review")
          : localSettings,
      );
      assert.deepEqual(
        yield* discoverClaudeSkills({ homePath: configDir }, aliasedWorkspace),
        localSettings,
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"enabledPlugins":{"local@shop":["^1.0.0"]}}',
      );
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true,"local@shop":true}}',
      );
      const separateRepository = path.join(workspace, "separate");
      yield* fs.makeDirectory(path.join(separateRepository, ".git"), { recursive: true });
      for (const cwd of [undefined, path.join(tempDir, "elsewhere"), separateRepository]) {
        const elsewhere = yield* discoverClaudeSkills({ homePath: configDir }, cwd);
        assert.deepEqual(
          elsewhere.map((skill) => [skill.name, skill.scope, skill.path]),
          [
            ["local:review", "user", path.join(managedInstall, "skills", "review", "SKILL.md")],
            ["plugin:review", "user", path.join(userInstall, "skills", "review", "SKILL.md")],
          ],
        );
      }
      const worktree = path.join(tempDir, "worktree");
      const worktreeGitDirectory = path.join(workspace, ".git", "worktrees", "fixture");
      yield* fs.makeDirectory(worktree);
      yield* fs.makeDirectory(worktreeGitDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
      yield* fs.writeFileString(path.join(worktreeGitDirectory, "commondir"), "../..\n");
      yield* fs.writeFileString(
        path.join(worktreeGitDirectory, "gitdir"),
        path.join(worktree, ".git"),
      );
      const linkedWorktree = path.join(tempDir, "linked-worktree");
      yield* linkDirectory(worktree, linkedWorktree);
      // A worktree reads the main checkout's settings.local.json, whose extended local@shop entry
      // enables nothing. On Windows it reads only its own, so the user's local@shop applies.
      for (const cwd of [worktree, linkedWorktree]) {
        assert.deepEqual(
          (yield* discoverClaudeSkills({ homePath: configDir }, cwd)).map((skill) => [
            skill.name,
            skill.scope,
            skill.path,
          ]),
          [
            ...(isWindowsHost
              ? [
                  [
                    "local:review",
                    "project",
                    path.join(localInstall, "skills", "review", "SKILL.md"),
                  ],
                ]
              : []),
            ["plugin:review", "project", path.join(projectInstall, "skills", "review", "SKILL.md")],
          ],
        );
      }
    }),
  );

  it.effect("resolves each install record's project repository once per discovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Real path: macOS temp dirs sit behind a /var -> /private/var symlink.
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" }),
      );
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const otherProject = path.join(tempDir, "other", "packages", "app");
      const sameRepoProject = path.join(workspace, "packages", "app");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(tempDir, "other", ".git"), { recursive: true });
      yield* fs.makeDirectory(otherProject, { recursive: true });
      yield* fs.makeDirectory(sameRepoProject, { recursive: true });
      const elsewhereInstall = path.join(configDir, "plugins", "elsewhere");
      const sameRepoInstall = path.join(configDir, "plugins", "same-repo");
      yield* writeSkill(path.join(elsewhereInstall, "skills"), "elsewhere", "# Elsewhere");
      yield* writeSkill(path.join(sameRepoInstall, "skills"), "same-repo", "# Same repo");
      const records = Array.from({ length: 4 }, () => ({
        scope: "project",
        projectPath: otherProject,
        installPath: elsewhereInstall,
      }));
      const plugins = ["a@shop", "b@shop", "c@shop"];
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            ...Object.fromEntries(plugins.map((key) => [key, records])),
            "d@shop": [
              { scope: "project", projectPath: sameRepoProject, installPath: sameRepoInstall },
            ],
          },
        }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: Object.fromEntries([...plugins, "d@shop"].map((key) => [key, true])),
        }),
      );

      const probed: Array<string> = [];
      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (target) => {
            probed.push(target);
            return fs.exists(target);
          },
        }),
      );
      assert.strictEqual(
        probed.filter((target) => target === path.join(otherProject, ".git")).length,
        1,
      );
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["d:same-repo"],
      );
    }),
  );

  it.effect("publishes and dispatches canonical plugin folder names regardless of aliases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const plugin = path.join(configDir, "plugins", "installed");
      yield* writeSkill(path.join(plugin, "skills"), "review", "---\nname: review-alias\n---\n");
      yield* writeSkill(path.join(plugin, "skills"), "alias", "---\nname: dot.alias\n---\n");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "plugin@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true}}',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });
      assert.deepEqual(
        planClaudeSkillDispatch(
          "$plugin:alias focus on auth",
          new Map(skills.map((skill) => [skill.name, skill])),
        ),
        {
          leadingText: undefined,
          commandText: "/plugin:alias focus on auth",
        },
      );
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["plugin:alias", "plugin:review"],
      );
    }),
  );

  it.effect("uses the native cache root, root-skill fallback and manifest path boundaries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(workspace, "config");
      const pluginsDir = path.join(workspace, "plugin-cache");
      const plugin = path.join(pluginsDir, "installed");
      const outside = path.join(workspace, "outside");
      yield* writeSkill(pluginsDir, "installed", "---\nname: plugin:root.alias\n---\n");
      yield* fs.makeDirectory(configDir);
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"plugin@shop":true}}',
      );
      yield* fs.writeFileString(
        path.join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({ plugins: { "plugin@shop": [{ scope: "user", installPath: plugin }] } }),
      );
      const environment = { CLAUDE_CODE_PLUGIN_CACHE_DIR: "plugin-cache" };
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace, environment)).map(
          (skill) => skill.name,
        ),
        ["plugin:root-alias"],
      );

      yield* writeSkill(path.join(plugin, "skills"), "plain", "# Plain");
      yield* writeSkill(plugin, "custom", "---\nname: custom.review\n---\n");
      yield* writeSkill(outside, "escaped", "# Outside");
      yield* fs.symlink(outside, path.join(plugin, "escape"));
      yield* fs.makeDirectory(path.join(plugin, ".claude-plugin"));
      yield* fs.writeFileString(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        '{"skills":["./custom","./escape","../../outside"]}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, workspace, environment)).map(
          (skill) => skill.name,
        ),
        ["plugin:custom-review", "plugin:plain"],
      );
    }),
  );

  it.effect("discovers skills from the current account's claude.ai synced plugins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const synced = path.join(configDir, "plugins", "synced");
      const organization = "11111111-2222-4333-8444-555555555555";
      const writeBucket = Effect.fn(function* (account: string, skillSuffix = "") {
        const bucket = path.join(synced, `${organization}_${account}`);
        const plugins = [
          {
            pluginId: "plugin_01pstack",
            name: "pstack",
            directory: "pstack",
            skill: "poteto-mode",
          },
          {
            pluginId: "plugin_01design",
            name: "0f6a7c9e-1111-4222-8333-444444444444",
            generation: 2,
            directory: "0f6a7c9e-1111-4222-8333-444444444444~g2",
            prefix: "design",
            skill: "design-critique",
          },
        ];
        for (const plugin of plugins) {
          const pluginDir = path.join(bucket, plugin.directory);
          yield* writeSkill(path.join(pluginDir, "skills"), plugin.skill + skillSuffix, "# Synced");
          yield* fs.makeDirectory(path.join(pluginDir, ".claude-plugin"));
          yield* fs.writeFileString(
            path.join(pluginDir, ".claude-plugin", "plugin.json"),
            JSON.stringify({ name: plugin.prefix ?? plugin.name }),
          );
        }
        yield* fs.writeFileString(
          path.join(bucket, "manifest.json"),
          JSON.stringify({
            lastUpdated: 1761990000000,
            plugins: plugins.map(({ pluginId, name, generation }) => ({
              pluginId,
              name,
              ...(generation ? { generation } : {}),
            })),
          }),
        );
        yield* fs.writeFileString(path.join(synced, `.bucket-${organization}_${account}`), "");
        return bucket;
      });
      const bucket = yield* writeBucket("66666666-7777-4888-9999-aaaaaaaaaaaa");
      yield* writeBucket("77777777-8888-4999-aaaa-bbbbbbbbbbbb", "-other-account");
      yield* fs.writeFileString(
        path.join(configDir, ".claude.json"),
        JSON.stringify({
          oauthAccount: {
            organizationUuid: organization,
            accountUuid: "66666666-7777-4888-9999-aaaaaaaaaaaa",
          },
        }),
      );

      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {})).map((skill) => [
          skill.name,
          skill.path,
        ]),
        [
          [
            "design:design-critique",
            path.join(
              bucket,
              "0f6a7c9e-1111-4222-8333-444444444444~g2",
              "skills",
              "design-critique",
              "SKILL.md",
            ),
          ],
          ["pstack:poteto-mode", path.join(bucket, "pstack", "skills", "poteto-mode", "SKILL.md")],
        ],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
          CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(configDir, "relocated-cache"),
        })).map((skill) => skill.name),
        ["design:design-critique", "pstack:poteto-mode"],
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
          CLAUDE_CODE_OAUTH_TOKEN: "token",
          CLAUDE_CODE_ACCOUNT_UUID: "77777777-8888-4999-aaaa-bbbbbbbbbbbb",
        })).map((skill) => skill.name),
        ["design:design-critique-other-account", "pstack:poteto-mode-other-account"],
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"enabledPlugins":{"pstack@synced":false}}',
      );
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {})).map(
          (skill) => skill.name,
        ),
        ["design:design-critique"],
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"syncClaudeAiPlugins":false}',
      );
      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, undefined, {}), []);
    }),
  );

  it.effect("gives a synced namespace to an installed plugin, then the first synced row", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const bucketName = "11111111-2222-4333-8444-555555555555_unbound";
      const synced = path.join(configDir, "plugins", "synced");
      const bucket = path.join(synced, bucketName);
      for (const [directory, prefix, skill] of [
        ["pstack", "pstack", "poteto-mode"],
        ["pstack-copy", "pstack", "copied"],
        ["tools", "tools", "synced-tool"],
        ["a_b", undefined, "renamed"],
        ["PSTACK", "PSTACK", "shouted"],
      ] as const) {
        yield* writeSkill(path.join(bucket, directory, "skills"), skill, "# Synced");
        if (prefix === undefined) continue;
        yield* fs.makeDirectory(path.join(bucket, directory, ".claude-plugin"));
        yield* fs.writeFileString(
          path.join(bucket, directory, ".claude-plugin", "plugin.json"),
          JSON.stringify({ name: prefix }),
        );
      }
      yield* fs.writeFileString(
        path.join(bucket, "manifest.json"),
        JSON.stringify({
          plugins: ["pstack", "pstack-copy", "tools", "a:b. ", "PSTACK", "no-id"].map(
            (name, index) => (name === "no-id" ? { name } : { pluginId: `plugin_0${index}`, name }),
          ),
        }),
      );
      yield* fs.writeFileString(path.join(synced, `.bucket-${bucketName}`), "");
      const installed = path.join(configDir, "plugins", "cache", "shop", "tools");
      yield* writeSkill(path.join(installed, "skills"), "installed-tool", "# Installed");
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({
          plugins: {
            "tools@shop": [{ scope: "user", installPath: installed }],
            "pstack@shop": [{ scope: "user", installPath: path.join(configDir, "missing") }],
          },
        }),
      );
      const names = (enabled: boolean) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            path.join(configDir, "settings.json"),
            JSON.stringify({ enabledPlugins: { "tools@shop": enabled, "pstack@shop": true } }),
          );
          const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
            CLAUDE_CODE_ORGANIZATION_UUID: "11111111-2222-4333-8444-555555555555",
            CLAUDE_CODE_ACCOUNT_UUID: "not-a-uuid",
          });
          return skills.map((skill) => skill.name);
        });

      assert.deepEqual(yield* names(true), [
        "a_b:renamed",
        "pstack:poteto-mode",
        "tools:installed-tool",
      ]);
      assert.deepEqual(yield* names(false), [
        "a_b:renamed",
        "pstack:poteto-mode",
        "tools:synced-tool",
      ]);
      yield* writeSkill(path.join(bucket, "no-id", "skills"), "unlisted", "# Synced");
      assert.notInclude(
        (yield* discoverClaudeSkills({ homePath: configDir }, undefined, {
          CLAUDE_CODE_ORGANIZATION_UUID: "11111111-2222-4333-8444-555555555555",
        })).map((skill) => skill.name),
        "no-id:unlisted",
      );
    }),
  );

  it.effect("hides synced plugins from local settings but not shared project settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const bucketName =
        "11111111-2222-4333-8444-555555555555_66666666-7777-4888-9999-aaaaaaaaaaaa";
      const synced = path.join(configDir, "plugins", "synced");
      yield* writeSkill(path.join(synced, bucketName, "pstack", "skills"), "poteto-mode", "# S");
      yield* fs.writeFileString(
        path.join(synced, bucketName, "manifest.json"),
        '{"plugins":[{"pluginId":"plugin_01pstack","name":"pstack"}]}',
      );
      yield* fs.writeFileString(path.join(synced, `.bucket-${bucketName}`), "");
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{"syncClaudeAiPlugins":false}',
      );
      const environment = {
        CLAUDE_CODE_ORGANIZATION_UUID: "11111111-2222-4333-8444-555555555555",
        CLAUDE_CODE_ACCOUNT_UUID: "66666666-7777-4888-9999-AAAAAAAAAAAA",
      };
      const names = Effect.map(
        discoverClaudeSkills({ homePath: configDir }, workspace, environment),
        (skills) => skills.map((skill) => skill.name),
      );
      assert.deepEqual(yield* names, ["pstack:poteto-mode"]);
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{"syncClaudeAiPlugins":false}',
      );
      assert.deepEqual(yield* names, []);
    }),
  );

  it.effect("discovers inline plugins from CLAUDE_CODE_PLUGIN_DIRS over installed namesakes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(workspace, "config");
      const named = path.join(workspace, "named");
      const unnamed = path.join(workspace, "unnamed");
      const inherited = path.join(workspace, "inherited");
      const muted = path.join(workspace, "muted");
      const installed = path.join(workspace, "installed-acme");
      yield* fs.makeDirectory(path.join(named, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(named, ".claude-plugin", "plugin.json"),
        '{"name":"acme"}',
      );
      yield* writeSkill(path.join(named, "skills"), "qa", "---\ndescription: QA a ticket\n---\n");
      yield* writeSkill(path.join(installed, "skills"), "old", "# Old");
      yield* writeSkill(path.join(unnamed, "skills"), "lint", "# Lint");
      yield* writeSkill(path.join(muted, "skills"), "hidden", "# Hidden");
      const quiet = path.join(workspace, "quiet");
      yield* fs.makeDirectory(path.join(quiet, ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(quiet, ".claude-plugin", "plugin.json"),
        '{"name":"quiet","defaultEnabled":false}',
      );
      yield* writeSkill(path.join(quiet, "skills"), "hush", "# Hush");
      const bundle = path.join(workspace, "bundle");
      yield* fs.makeDirectory(path.join(bundle, "tools", ".claude-plugin"), { recursive: true });
      yield* fs.writeFileString(
        path.join(bundle, "tools", ".claude-plugin", "plugin.json"),
        '{"name":"tools"}',
      );
      yield* writeSkill(path.join(bundle, "tools", "skills"), "fmt", "# Fmt");
      yield* writeSkill(path.join(bundle, "loose", "skills"), "ignored", "# Ignored");
      yield* writeSkill(path.join(inherited, "skills"), "stale", "# Stale");
      yield* writeSkill(path.join(workspace, "relative", "skills"), "skipped", "# Skipped");
      yield* fs.makeDirectory(path.join(configDir, "plugins"), { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "plugins", "installed_plugins.json"),
        JSON.stringify({ plugins: { "acme@shop": [{ scope: "user", installPath: installed }] } }),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({
          enabledPlugins: { "acme@shop": true, "muted@inline": false },
          env: {
            CLAUDE_CODE_PLUGIN_DIRS: [named, "relative", ` ${unnamed} `, muted, quiet, bundle].join(
              ";",
            ),
          },
        }),
      );

      const skills = yield* discoverOnWindows({ homePath: configDir }, workspace, {
        CLAUDE_CODE_PLUGIN_DIRS: inherited,
      });
      assert.deepEqual(
        skills.map(({ name, scope, description }) => ({ name, scope, description })),
        [
          { name: "acme:qa", scope: "user", description: "QA a ticket" },
          { name: "tools:fmt", scope: "user", description: undefined },
          { name: "unnamed:lint", scope: "user", description: undefined },
        ],
      );

      // Policy enabledPlugins entries lock their plugin name against inline copies.
      vi.mocked(ClaudeSdk.resolveSettings).mockResolvedValue({
        effective: { enabledPlugins: { "acme@shop": true } },
        provenance: {},
        sources: [],
      });
      assert.deepEqual(
        (yield* discoverOnWindows({ homePath: path.join(workspace, "empty") }, workspace, {
          CLAUDE_CODE_PLUGIN_DIRS: [named, unnamed].join(";"),
        })).map((skill) => skill.name),
        ["unnamed:lint"],
      );

      assert.deepEqual(
        (yield* discoverOnWindows({ homePath: path.join(workspace, "empty") }, workspace, {
          CLAUDE_CODE_PLUGIN_DIRS: inherited,
        })).map((skill) => skill.name),
        ["inherited:stale"],
      );
    }),
  );

  it.effect("discovers user and project skills with frontmatter metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "codex-review",
        [
          "---",
          "name: codex-review",
          "description: Ask Codex for a review.",
          "---",
          "",
          "# Body",
        ].join("\n"),
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "deploy",
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(skills, [
        {
          name: "codex-review",
          path: path.join(configDir, "skills", "codex-review", "SKILL.md"),
          enabled: true,
          scope: "user",
          description: "Ask Codex for a review.",
        },
        {
          name: "deploy",
          path: path.join(workspace, ".claude", "skills", "deploy", "SKILL.md"),
          enabled: true,
          scope: "project",
          description: "Deploy the app.",
        },
      ]);
    }),
  );

  it.effect("discovers skills from the instance's --add-dir launch args", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      const extraDir = path.join(workspace, "extra skills");
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* writeSkill(
        path.join(extraDir, ".claude", "skills"),
        "demo",
        ["---", "description: From an additional directory.", "---"].join("\n"),
      );

      assert.deepEqual(yield* discoverClaudeSkills({ homePath: configDir }, workspace), []);
      for (const launchArgs of [
        `--add-dir "${extraDir}"`,
        `--add-dir="${extraDir}"`,
        '--add-dir "extra skills"',
        '--add-dir="extra skills"',
        `--add-dir missing --add-dir "${extraDir}"`,
        `--add-dir "${extraDir}" --add-dir missing`,
        `--add-dir missing "${extraDir}"`,
      ]) {
        const settings = { homePath: configDir, launchArgs };
        const skills = yield* discoverClaudeSkills(settings, workspace);
        assert.deepEqual(skills, [
          {
            name: "demo",
            path: path.join(extraDir, ".claude", "skills", "demo", "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "From an additional directory.",
          },
        ]);
      }
      const settings = { homePath: configDir, launchArgs: `--add-dir "${extraDir}"` };
      const skills = yield* discoverClaudeSkills(settings, workspace);
      assert.deepEqual(
        planClaudeSkillDispatch(
          "$demo",
          new Map(skills.map((skill) => [skill.name, { path: skill.path }])),
        ),
        {
          leadingText: undefined,
          commandText: "/demo",
        },
      );
      yield* writeSkill(
        path.join(workspace, ".claude", "skills"),
        "demo",
        "---\ndescription: Project copy.\n---",
      );
      const projectSkills = yield* discoverClaudeSkills(settings, workspace);
      assert.equal(projectSkills[0]?.description, "Project copy.");
      for (const launchArgs of ["--add-dir", '--add-dir=""', '--add-dir "extra skills"']) {
        const settings = { homePath: configDir, launchArgs };
        assert.deepEqual(yield* discoverClaudeSkills(settings), []);
      }
    }),
  );

  it.effect(
    "prefers Claude's own skills over shared ones, and ignores a project .agents copy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
        const configDir = path.join(tempDir, "claude-home");
        const workspace = path.join(tempDir, "workspace");
        const home = path.join(tempDir, "home");

        yield* writeSkill(
          path.join(configDir, "skills"),
          "deploy",
          ["---", "name: deploy", "description: User deploy.", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills"),
          "deploy",
          ["---", "name: deploy", "description: Agents deploy.", "---"].join("\n"),
        );
        yield* writeSkill(
          path.join(workspace, ".claude", "skills"),
          "deploy",
          ["---", "name: deploy", "description: Claude deploy.", "---"].join("\n"),
        );
        for (const name of ["deploy", "review"]) {
          yield* writeSkill(
            path.join(home, ".agents", "skills"),
            name,
            ["---", `name: ${name}`, "description: Shared.", "---"].join("\n"),
          );
        }

        const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );

        assert.deepEqual(skills, [
          {
            name: "deploy",
            path: path.join(configDir, "skills", "deploy", "SKILL.md"),
            enabled: true,
            scope: "user",
            description: "User deploy.",
          },
          {
            name: "review",
            path: path.join(home, ".agents", "skills", "review", "SKILL.md"),
            enabled: true,
            scope: "user",
            description: "Shared.",
          },
        ]);
      }),
  );

  it.effect("links the shared skills folder for Claude without touching a real folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" }),
      );
      const home = path.join(tempDir, "home");
      const bridge = path.join(tempDir, "bridge");
      const link = path.join(bridge, ".claude", "skills");
      const linkShared = (bridgeDirectory: string) =>
        linkClaudeSharedSkills(bridgeDirectory, path.join(tempDir, "claude-home")).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );

      assert.isUndefined(yield* linkShared(bridge));
      assert.isFalse(yield* fs.exists(bridge));

      yield* writeSkill(path.join(home, ".agents", "skills"), "review", "---\n---");
      const elsewhere = path.join(tempDir, "elsewhere");
      yield* fs.makeDirectory(elsewhere);
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(elsewhere, link);
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(yield* linkShared(bridge), bridge);
        assert.isTrue(yield* fs.exists(path.join(link, "review", "SKILL.md")));
      }

      const realFolder = path.join(tempDir, "real", ".claude", "skills");
      yield* writeSkill(realFolder, "mine", "---\n---");
      assert.isUndefined(yield* linkShared(path.join(tempDir, "real")));
      assert.isTrue(yield* fs.exists(path.join(realFolder, "mine", "SKILL.md")));
    }),
  );

  it.effect("prefers managed skills over user skills, with policy skillOverrides last", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const programFiles = path.join(tempDir, "Program Files");
      const programData = path.join(tempDir, "ProgramData");
      const deploy = (description: string) =>
        ["---", "name: deploy", `description: ${description}`, "---"].join("\n");
      yield* writeSkill(path.join(configDir, "skills"), "deploy", deploy("User deploy."));
      yield* writeSkill(
        path.join(programData, "ClaudeCode", ".claude", "skills"),
        "legacy-only",
        "# Legacy skills must not be discovered",
      );
      yield* writeSkill(
        path.join(programFiles, "ClaudeCode", ".claude", "skills"),
        "deploy",
        deploy("Managed deploy."),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{"skillOverrides":{"deploy":"off"}}',
      );
      const discoverManaged = (environment: NodeJS.ProcessEnv) =>
        discoverOnWindows({ homePath: configDir }, undefined, {
          PROGRAMDATA: programData,
          ...environment,
        });
      const userSkill = {
        name: "deploy",
        path: path.join(configDir, "skills", "deploy", "SKILL.md"),
        enabled: false,
        scope: "user" as const,
        description: "User deploy.",
      };
      for (const environment of [{}, { ProgramFiles: "" }]) {
        assert.deepEqual(yield* discoverManaged(environment), [userSkill]);
      }
      const managedSkill = {
        ...userSkill,
        path: path.join(programFiles, "ClaudeCode", ".claude", "skills", "deploy", "SKILL.md"),
        description: "Managed deploy.",
      };
      assert.deepEqual(yield* discoverManaged({ ProgramFiles: programFiles }), [managedSkill]);
      assert.deepEqual(yield* discoverManaged({ PROGRAMFILES: ` ${programFiles} ` }), [
        managedSkill,
      ]);

      vi.mocked(ClaudeSdk.resolveSettings).mockResolvedValue({
        effective: { skillOverrides: { deploy: "on" } },
        provenance: {},
        sources: [],
      });
      assert.deepEqual(yield* discoverManaged({ ProgramFiles: programFiles }), [
        { ...managedSkill, enabled: true },
      ]);
    }),
  );

  it.effect("leaves the shared skills to a Claude skills folder that links them itself", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" }),
      );
      const home = path.join(tempDir, "home");
      const shared = path.join(home, ".agents", "skills");
      const configDir = path.join(tempDir, "claude-home");
      const bridge = path.join(tempDir, "bridge");
      const link = path.join(bridge, ".claude", "skills");
      const withHome = Effect.provideService(HostProcess.HomeDirectory, home);
      for (const name of ["review", "audit-full"]) {
        yield* writeSkill(shared, name, `---\nname: ${name}\n---`);
      }
      yield* writeSkill(path.join(configDir, "skills"), "mine", "---\nname: mine\n---");
      assert.equal(yield* linkClaudeSharedSkills(bridge, configDir).pipe(withHome), bridge);

      // A machine setup links only the shared skills it switches on, here not audit-full.
      yield* fs.symlink(path.join(shared, "review"), path.join(configDir, "skills", "review"));

      assert.isUndefined(yield* linkClaudeSharedSkills(bridge, configDir).pipe(withHome));
      assert.isFalse(yield* fs.exists(path.join(link, "audit-full")));
      assert.isTrue(yield* fs.exists(path.join(shared, "audit-full", "SKILL.md")));
      assert.deepEqual(
        (yield* discoverClaudeSkills({ homePath: configDir }).pipe(withHome)).map(
          (skill) => skill.path,
        ),
        [
          path.join(configDir, "skills", "mine", "SKILL.md"),
          path.join(configDir, "skills", "review", "SKILL.md"),
        ],
      );
    }),
  );

  it.effect("recovers colon-bearing descriptions with invocation metadata intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const [description, comment] of [
        ["Browser automation + AI test authoring via kane-cli: run browser objectives, ...", ""],
        ['Read C:\\skills\\guide#tag: continue with "quoted".', " # trailing: comment"],
      ] as const) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          "kane-cli",
          [
            "---",
            "name: frontmatter-alias",
            `description: ${description}${comment}`,
            "allowed-tools: [Read, Write]",
            "disable-model-invocation: yes",
            "user-invocable: no",
            "---",
          ].join("\n"),
        );

        const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

        assert.deepEqual(skills, [
          {
            name: "kane-cli",
            path: path.join(configDir, "skills", "kane-cli", "SKILL.md"),
            enabled: true,
            scope: "user",
            description,
            userInvocationOnly: true,
            userInvocable: false,
          },
        ]);
      }
    }),
  );

  it.effect("falls back to the directory name and skips malformed frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(skillsDir, "no-frontmatter", "# Just a heading\n");
      for (const [directoryName, field] of [
        ["broken-yaml", "name: [unclosed"],
        ["broken-tools", "allowed-tools: [Read, Write"],
        ["broken-quoted", 'name: "unclosed: text'],
      ] as const) {
        yield* writeSkill(
          skillsDir,
          directoryName,
          ["---", "description: Run: browser objectives.", field, "---"].join("\n"),
        );
      }
      yield* fs.makeDirectory(skillsDir, { recursive: true });
      yield* fs.writeFileString(path.join(skillsDir, "README.md"), "not a skill");

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, undefined);

      // Claude falls back to directory names without frontmatter, but skips malformed frontmatter.
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["no-frontmatter"],
      );
      assert.equal(skills[0]?.description, undefined);
    }),
  );

  it.effect("honors CLAUDE_CONFIG_DIR from the environment when homePath is unset", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const environmentConfigDir = path.join(tempDir, "env-config");

      yield* writeSkill(
        path.join(environmentConfigDir, "skills"),
        "env-skill",
        ["---", "name: env-skill", "description: From env config dir.", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["env-skill"],
      );

      const explicitHome = path.join(tempDir, "explicit-home");
      yield* writeSkill(
        path.join(explicitHome, "skills"),
        "explicit-skill",
        ["---", "name: explicit-skill", "---"].join("\n"),
      );
      const explicitSkills = yield* discoverClaudeSkills({ homePath: explicitHome }, undefined, {
        CLAUDE_CONFIG_DIR: environmentConfigDir,
      });
      assert.deepEqual(
        explicitSkills.map((skill) => skill.name),
        ["explicit-skill"],
      );
    }),
  );

  it.effect.each([
    ["the user settings", { autoUpdatesChannel: "stable" }, undefined, Option.some("stable")],
    ["latest when no settings name one", undefined, undefined, Option.some("latest")],
    [
      "the account's server-managed settings above the user's",
      { autoUpdatesChannel: "stable" },
      { autoUpdatesChannel: "rc" },
      Option.some("rc"),
    ],
    [
      "nothing when a policy helper may set it",
      { autoUpdatesChannel: "stable" },
      POLICY_HELPER,
      Option.none(),
    ],
  ] as const)("reads autoUpdatesChannel from %s", ([, user, remote, expected]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-channel-" });
      if (user !== undefined) {
        yield* fs.writeFileString(path.join(configDir, "settings.json"), JSON.stringify(user));
      }
      if (remote !== undefined) {
        yield* useRealResolver();
        yield* fs.writeFileString(
          path.join(configDir, "remote-settings.json"),
          JSON.stringify(remote),
        );
      }

      const channel = yield* readClaudeAutoUpdatesChannel({ CLAUDE_CONFIG_DIR: configDir });

      assert.deepEqual(channel, expected);
    }),
  );

  it.effect("resolves a relative CLAUDE_CONFIG_DIR against the workspace cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const workspace = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspace, { recursive: true });

      // The CLI resolves relative CLAUDE_CONFIG_DIR against workspace cwd.
      yield* writeSkill(
        path.join(workspace, "relative-config", "skills"),
        "relative-skill",
        ["---", "name: relative-skill", "---"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: "" }, workspace, {
        CLAUDE_CONFIG_DIR: "relative-config",
      });

      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["relative-skill"],
      );
      assert.equal(skills[0]?.scope, "user");
    }),
  );

  it.effect("disables skills switched off by skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");

      for (const name of ["kept", "off-by-user", "off-by-project"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }

      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "off-by-user": "off", "kept": "on" } }',
      );
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{ "skillOverrides": { "off-by-project": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["kept", true],
          ["off-by-project", false],
          ["off-by-user", false],
        ],
      );
    }),
  );

  it.effect.each([
    [
      "only the settings files its launch arguments name",
      "--setting-sources user",
      undefined,
      [
        ["kept", true],
        ["off-by-project", true],
      ],
    ],
    [
      "a managed drop-in above every file",
      "",
      { resolved: { skillOverrides: { kept: "off" } } },
      [
        ["kept", false],
        ["off-by-project", false],
      ],
    ],
    [
      "the account's server-managed settings above every file",
      "",
      { remote: { skillOverrides: { kept: "off" } } },
      [
        ["kept", false],
        ["off-by-project", false],
      ],
    ],
    // Its settings may turn any skill off, so none is offered.
    ["nothing when a policy helper may add to them", "", { remote: POLICY_HELPER }, []],
  ] as const)("takes skillOverrides from %s", ([, launchArgs, policy, expected]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const workspace = path.join(tempDir, "workspace");
      for (const name of ["kept", "off-by-project"]) {
        yield* writeSkill(path.join(configDir, "skills"), name, `---\nname: ${name}\n---\n`);
      }
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.json"),
        '{ "skillOverrides": { "off-by-project": "off" } }',
      );
      const resolveSettings = vi.mocked(ClaudeSdk.resolveSettings);
      if (policy !== undefined && "resolved" in policy) {
        resolveSettings.mockResolvedValue({
          effective: policy.resolved,
          provenance: {},
          sources: [
            {
              source: "managed",
              path: "/Library/Application Support/ClaudeCode/managed-settings.d/50-skills.json",
              settings: policy.resolved,
            },
          ],
        });
      }
      if (policy !== undefined && "remote" in policy) {
        yield* useRealResolver();
        yield* fs.writeFileString(
          path.join(configDir, "remote-settings.json"),
          JSON.stringify(policy.remote),
        );
      }

      const skills = yield* discoverClaudeSkills({ homePath: configDir, launchArgs }, workspace);

      assert.deepEqual<ReadonlyArray<readonly [string, boolean]>>(
        skills.map((skill) => [skill.name, skill.enabled]),
        expected,
      );
      // An empty cache keeps the resolver off this process's own account's.
      if (policy !== undefined && "resolved" in policy) {
        assert.deepEqual(resolveSettings.mock.calls[0]?.[0], {
          settingSources: [],
          serverManagedSettings: {},
        });
      }
    }),
  );

  it.effect("ignores unreadable settings when resolving skillOverrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(path.join(configDir, "settings.json"), "{ not json");

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("treats a user-invocable-only override like disable-model-invocation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "ask-matt",
        ["---", "name: ask-matt", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "ask-matt": "user-invocable-only" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled, skill.userInvocationOnly === true]),
        [["ask-matt", true, true]],
      );
    }),
  );

  it.effect("drops every override in a file when one value is invalid, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      for (const name of ["unknown-mode", "boolean-false", "sibling-off"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      // Claude ignores the entire override map when any value is an unknown string or boolean.
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "unknown-mode": "some-future-mode", "boolean-false": false, "sibling-off": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [
          ["boolean-false", true],
          ["sibling-off", true],
          ["unknown-mode", true],
        ],
      );
    }),
  );

  it.effect("reads repository root settings from a nested workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const repo = path.join(tempDir, "repo");
      const workspace = path.join(repo, "packages", "app");

      for (const name of ["root-off", "root-off-cwd-on", "cwd-off-root-on"]) {
        yield* writeSkill(
          path.join(configDir, "skills"),
          name,
          ["---", `name: ${name}`, "---", "", "# Body"].join("\n"),
        );
      }
      yield* fs.makeDirectory(path.join(repo, ".git"), { recursive: true });
      yield* fs.makeDirectory(path.join(repo, ".claude"), { recursive: true });
      yield* fs.makeDirectory(path.join(workspace, ".claude"), { recursive: true });
      // The CLI ignores the root's plain settings.json from a nested cwd.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.json"),
        '{ "skillOverrides": { "cwd-off-root-on": "off" } }',
      );
      // The root local file outranks the workspace local file, as in the CLI.
      yield* fs.writeFileString(
        path.join(repo, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off": "off", "root-off-cwd-on": "off", "cwd-off-root-on": "on" } }',
      );
      yield* fs.writeFileString(
        path.join(workspace, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "root-off-cwd-on": "on", "cwd-off-root-on": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        // Windows keeps the local file in cwd, so the root's files never apply.
        isWindowsHost
          ? [
              ["cwd-off-root-on", false],
              ["root-off", true],
              ["root-off-cwd-on", true],
            ]
          : [
              ["cwd-off-root-on", true],
              ["root-off", false],
              ["root-off-cwd-on", false],
            ],
      );
    }),
  );

  it.effect("ignores ancestor settings outside a repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const parent = path.join(tempDir, "not-a-repo");
      const workspace = path.join(parent, "workspace");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "kept",
        ["---", "name: kept", "---", "", "# Body"].join("\n"),
      );
      yield* fs.makeDirectory(path.join(parent, ".claude"), { recursive: true });
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(parent, ".claude", "settings.local.json"),
        '{ "skillOverrides": { "kept": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir }, workspace);

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["kept", true]],
      );
    }),
  );

  it.effect("identifies a skill by its directory, as Claude Code does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias-frontmatter": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias", true]],
      );
    }),
  );

  // regression: #9128 skills picked from the composer did not run
  it.effect("switches a skill off by its directory name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");

      yield* writeSkill(
        path.join(configDir, "skills"),
        "probe-alias",
        ["---", "name: probe-alias-frontmatter", "---", "", "# Body"].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        '{ "skillOverrides": { "probe-alias": "off" } }',
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.enabled]),
        [["probe-alias", false]],
      );
    }),
  );

  it.effect("accepts the YAML 1.1 boolean spellings Claude Code allows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const configDir = path.join(tempDir, "claude-home");
      const skillsDir = path.join(configDir, "skills");

      yield* writeSkill(
        skillsDir,
        "user-only-yes",
        ["---", "disable-model-invocation: yes", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "agent-only-no",
        ["---", "user-invocable: no", "---", "", "# Body"].join("\n"),
      );
      yield* writeSkill(
        skillsDir,
        "plain-off",
        ["---", "disable-model-invocation: off", "---", "", "# Body"].join("\n"),
      );

      const skills = yield* discoverClaudeSkills({ homePath: configDir });

      assert.deepEqual(
        skills.map((skill) => [
          skill.name,
          skill.userInvocationOnly === true,
          skill.userInvocable === false,
        ]),
        [
          ["agent-only-no", false, true],
          ["plain-off", false, false],
          ["user-only-yes", true, false],
        ],
      );
    }),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, isolatedHome))("setClaudeSkillOverride", (it) => {
  const makeConfigDir = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-override-" });
    const settingsPath = path.join(configDir, "settings.json");
    return { fs, configDir, settingsPath };
  });

  it.effect("creates the settings file when it is missing and the skill is turned off", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      yield* setClaudeSkillOverride({ configDir, name: "plan", enabled: false });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(settingsPath)), {
        skillOverrides: { plan: "off" },
      });
    }),
  );

  it.effect("keeps every other setting and override, including in a hand-edited file", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      yield* fs.writeFileString(
        settingsPath,
        `{
  // trailing commas and comments are fine for Claude Code
  "model": "opus",
  "env": { "A": "1", },
  "skillOverrides": { "review": "user-invocable-only", },
}`,
      );
      yield* setClaudeSkillOverride({ configDir, name: "plan", enabled: false });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(settingsPath)), {
        model: "opus",
        env: { A: "1" },
        skillOverrides: { review: "user-invocable-only", plan: "off" },
      });
    }),
  );

  it.effect("removes the override when enabling, and the map once it is empty", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      yield* fs.writeFileString(
        settingsPath,
        JSON.stringify({ model: "opus", skillOverrides: { plan: "off", review: "off" } }),
      );
      yield* setClaudeSkillOverride({ configDir, name: "plan", enabled: true });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(settingsPath)), {
        model: "opus",
        skillOverrides: { review: "off" },
      });
      yield* setClaudeSkillOverride({ configDir, name: "review", enabled: true });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(settingsPath)), { model: "opus" });
    }),
  );

  it.effect("does not write when the skill is already in the requested state", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      yield* setClaudeSkillOverride({ configDir, name: "plan", enabled: true });
      assert.isFalse(yield* fs.exists(settingsPath));
    }),
  );

  it.effect("leaves a settings file it cannot parse untouched", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      yield* fs.writeFileString(settingsPath, "{ not json");
      const failure = yield* setClaudeSkillOverride({
        configDir,
        name: "plan",
        enabled: false,
      }).pipe(Effect.flip);
      assert.isDefined(failure);
      assert.equal(yield* fs.readFileString(settingsPath), "{ not json");
    }),
  );

  it.effect("keeps both overrides when two skills are toggled at once", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      const names = ["a", "b", "c", "d", "e", "f"];
      yield* Effect.forEach(
        names,
        (name) => setClaudeSkillOverride({ configDir, name, enabled: false }),
        { concurrency: "unbounded", discard: true },
      );
      assert.deepEqual(
        Object.keys(JSON.parse(yield* fs.readFileString(settingsPath)).skillOverrides).toSorted(),
        names,
      );
    }),
  );

  it.effect("keeps both overrides when two accounts share a linked settings file", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      const path = yield* Path.Path;
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-override-" });
      yield* fs.writeFileString(settingsPath, "{}");
      yield* fs.symlink(settingsPath, path.join(secondDir, "settings.json"));
      const names = ["a", "b", "c", "d", "e", "f"];
      yield* Effect.forEach(
        names,
        (name, index) =>
          setClaudeSkillOverride({
            configDir: index % 2 === 0 ? configDir : secondDir,
            name,
            enabled: false,
          }),
        { concurrency: "unbounded", discard: true },
      );
      assert.deepEqual(
        Object.keys(JSON.parse(yield* fs.readFileString(settingsPath)).skillOverrides).toSorted(),
        names,
      );
      assert.isTrue((yield* fs.readLink(path.join(secondDir, "settings.json"))) === settingsPath);
    }),
  );

  // Windows has no POSIX mode bits to keep.
  it.effect.skipIf(isWindowsHost)("keeps the permission mode of an existing settings file", () =>
    Effect.gen(function* () {
      const { fs, configDir, settingsPath } = yield* makeConfigDir;
      yield* fs.writeFileString(settingsPath, "{}");
      yield* fs.chmod(settingsPath, 0o600);
      yield* setClaudeSkillOverride({ configDir, name: "plan", enabled: false });
      assert.equal((yield* fs.stat(settingsPath)).mode & 0o777, 0o600);
    }),
  );
});
