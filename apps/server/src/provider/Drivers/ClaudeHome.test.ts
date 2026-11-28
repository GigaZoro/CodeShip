import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  validateClaudeBillingSettings,
  mergeClaudeInstanceEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  it.effect("isolates API and subscription credentials by billing mode", () =>
    Effect.gen(function* () {
      const ambient = {
        ANTHROPIC_API_KEY: "ambient",
        ANTHROPIC_AUTH_TOKEN: "bearer",
        CLAUDE_CODE_OAUTH_TOKEN: "plan-token",
      };
      const plan = yield* makeClaudeEnvironment(
        { homePath: "", billingKind: "plan", apiKey: "stored" },
        ambient,
      );
      expect(plan).toEqual({
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "plan-token",
      });
      const api = yield* makeClaudeEnvironment(
        { homePath: "", billingKind: "payPerUse", apiKey: "stored" },
        ambient,
      );
      expect(api).toEqual({
        ANTHROPIC_API_KEY: "stored",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      });
      const missingKey = yield* makeClaudeEnvironment(
        { homePath: "", billingKind: "payPerUse" },
        ambient,
      );
      expect(missingKey).toEqual({
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      });
      const missingKeyError = yield* validateClaudeBillingSettings(
        { billingKind: "payPerUse", apiKey: "" },
        [],
      ).pipe(Effect.flip);
      expect(missingKeyError._tag).toBe("ClaudeBillingConfigurationError");
      const mismatch = yield* validateClaudeBillingSettings({ billingKind: "plan", apiKey: "" }, [
        { env: { ANTHROPIC_API_KEY: "project-key" } },
      ]).pipe(Effect.flip);
      expect(mismatch._tag).toBe("ClaudeBillingConfigurationError");
      yield* validateClaudeBillingSettings({ billingKind: "payPerUse", apiKey: "stored" }, [
        { env: { ANTHROPIC_API_KEY: "stored" } },
      ]);
      const oauthMismatch = yield* validateClaudeBillingSettings(
        { billingKind: "payPerUse", apiKey: "stored" },
        [{ env: { CLAUDE_CODE_OAUTH_TOKEN: "plan" } }],
      ).pipe(Effect.flip);
      expect(oauthMismatch._tag).toBe("ClaudeBillingConfigurationError");
    }),
  );
  it.effect.each([
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
  ])("rejects alternate billing via inherited or project %s", (key) =>
    Effect.gen(function* () {
      const env = { [key]: key === "ANTHROPIC_BASE_URL" ? "https://other.example" : "1" };
      for (const billingKind of ["plan", "payPerUse"] as const) {
        const config = { billingKind, apiKey: "stored" };
        const inherited = yield* validateClaudeBillingSettings(config, [], env).pipe(Effect.flip);
        const project = yield* validateClaudeBillingSettings(config, [{ env }]).pipe(Effect.flip);
        expect(inherited._tag).toBe("ClaudeBillingConfigurationError");
        expect(project._tag).toBe("ClaudeBillingConfigurationError");
      }
    }),
  );
  describe("Claude home resolution", () => {
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );

        const processFolder = (CLAUDE_CONFIG_DIR: string) =>
          mergeClaudeProcessEnvironment({ homePath: "" }, undefined, { CLAUDE_CONFIG_DIR }).pipe(
            Effect.map((processEnv) => processEnv.CLAUDE_CONFIG_DIR),
          );
        const unnormalized = `${inherited}${path.sep}`;
        expect(yield* processFolder(unnormalized)).toBe(unnormalized);
        expect(yield* processFolder("claude-relative")).toBe(path.resolve("claude-relative"));
      }),
    );

    it.effect("keeps the machine's Claude token for the default provider only", () =>
      Effect.gen(function* () {
        const machine = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "machine-token" };
        const defaultEnv = yield* mergeClaudeInstanceEnvironment(
          ProviderInstanceId.make("claudeAgent"),
          [],
          machine,
        );
        const addedEnv = yield* mergeClaudeInstanceEnvironment(
          ProviderInstanceId.make("claudeAgent_personal"),
          [],
          machine,
        );
        const addedWithToken = yield* mergeClaudeInstanceEnvironment(
          ProviderInstanceId.make("claudeAgent_work"),
          [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "work-token", sensitive: true }],
          machine,
        );
        const defaultIgnoringMachineToken = yield* mergeClaudeInstanceEnvironment(
          ProviderInstanceId.make("claudeAgent"),
          [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: false }],
          machine,
        );

        expect(defaultEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("machine-token");
        expect(addedEnv).toEqual({ PATH: "/bin" });
        expect(addedWithToken.CLAUDE_CODE_OAUTH_TOKEN).toBe("work-token");
        expect(defaultIgnoringMachineToken).toEqual({ PATH: "/bin" });
      }),
    );

    it.effect("gives a symlinked Claude home the continuation key of its target", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
        const target = path.join(root, ".claude");
        const link = path.join(root, ".claude-second-account");
        yield* fileSystem.makeDirectory(target);
        yield* fileSystem.symlink(target, link);

        const direct = yield* makeClaudeContinuationGroupKey({ homePath: target });
        expect(yield* makeClaudeContinuationGroupKey({ homePath: link })).toBe(direct);
        expect(
          yield* makeClaudeContinuationGroupKey({ homePath: "" }, { CLAUDE_CONFIG_DIR: link }),
        ).toBe(direct);
        // The spawned process keeps the literal path, because Claude keys its login by that path.
        expect((yield* makeClaudeEnvironment({ homePath: link })).CLAUDE_CONFIG_DIR).toBe(link);
      }).pipe(Effect.scoped),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });

  it.effect(
    "drops the launching Claude session and Electron's run-as-Node flag, and labels processes t3-code unless overridden",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
        const host = {
          CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/host-claude.sock",
          CLAUDE_EFFORT: "high",
          ELECTRON_RUN_AS_NODE: "1",
          KEEP: "1",
        };
        const instance = [
          { name: "CLAUDE_CODE_ENTRYPOINT", value: "instance", sensitive: false },
          { name: "CLAUDE_EFFORT", value: "low", sensitive: false },
        ];

        expect(yield* mergeClaudeProcessEnvironment({ homePath }, undefined, host)).toMatchObject({
          CLAUDE_CODE_ENTRYPOINT: "t3-code",
          KEEP: "1",
        });
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("instance");
        // Only the entrypoint is applied again: the merged host env already dropped a blank token.
        const fullInstance = [
          { name: "claude_code_entrypoint", value: "instance", sensitive: false },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: false },
        ];
        const onWindows = yield* mergeClaudeProcessEnvironment(
          { homePath },
          fullInstance,
          host,
        ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
        expect(onWindows.CLAUDE_CODE_ENTRYPOINT).toBe("instance");
        expect(onWindows).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");

        yield* fileSystem.writeFileString(
          path.join(homePath, "settings.json"),
          JSON.stringify({ env: { CLAUDE_CODE_ENTRYPOINT: "custom" } }),
        );
        expect(
          (yield* mergeClaudeProcessEnvironment({ homePath }, instance, host))
            .CLAUDE_CODE_ENTRYPOINT,
        ).toBe("custom");
      }),
  );
});
