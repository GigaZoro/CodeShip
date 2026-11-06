import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { materializeClaudeAccountHome, shareClaudeMcpServers } from "./ClaudeAccountHome.ts";

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeUnknownEffect(Json);

it.layer(NodeServices.layer)("materializeClaudeAccountHome", (it) => {
  it.effect("shares every Claude file with the account except its own login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-" }));
      const sharedHome = path.join(root, ".claude");
      const accountHome = path.join(root, "account", "home");
      yield* fs.makeDirectory(path.join(sharedHome, "skills", "review"), { recursive: true });
      yield* fs.writeFileString(path.join(sharedHome, "skills", "review", "SKILL.md"), "---\n---");
      yield* fs.writeFileString(path.join(sharedHome, "CLAUDE.md"), "Shared rules");
      yield* fs.writeFileString(path.join(sharedHome, "settings.json"), "{}");
      for (const name of [
        ".credentials.json",
        ".claude.json",
        "remote-settings.json",
        "mcp-needs-auth-cache.json",
      ]) {
        yield* fs.writeFileString(path.join(sharedHome, name), "shared login");
      }
      yield* fs.makeDirectory(path.join(sharedHome, "backups"));
      yield* fs.makeDirectory(path.join(sharedHome, ".claude.json.lock"));
      yield* fs.makeDirectory(path.join(sharedHome, ".storage-write.lock"));
      yield* fs.makeDirectory(accountHome, { recursive: true });
      yield* fs.writeFileString(path.join(accountHome, "settings.json"), "account's own");
      yield* fs.symlink(path.join(root, "elsewhere"), path.join(accountHome, "CLAUDE.md"));
      const releasedLock = path.join(accountHome, ".storage-write.lock");
      yield* fs.symlink(path.join(sharedHome, "released.lock"), releasedLock);
      yield* fs.symlink(
        path.join(sharedHome, "mcp-needs-auth-cache.json"),
        path.join(accountHome, "mcp-needs-auth-cache.json"),
      );
      // Windows links files with a hard link when a symlink needs elevation.
      yield* fs.link(
        path.join(sharedHome, "remote-settings.json"),
        path.join(accountHome, "remote-settings.json"),
      );

      for (let run = 0; run < 2; run++) {
        yield* materializeClaudeAccountHome({ sharedHome, accountHome });
      }

      assert.strictEqual(
        yield* fs.readFileString(path.join(accountHome, "skills", "review", "SKILL.md")),
        "---\n---",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(accountHome, "CLAUDE.md")),
        "Shared rules",
      );
      assert.strictEqual(
        yield* fs.realPath(path.join(accountHome, "projects")),
        path.join(sharedHome, "projects"),
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(accountHome, "settings.json")),
        "account's own",
      );
      for (const name of [
        ".credentials.json",
        ".claude.json",
        ".claude.json.lock",
        ".storage-write.lock",
        "mcp-needs-auth-cache.json",
        "remote-settings.json",
        "backups",
      ]) {
        assert.isFalse(yield* fs.exists(path.join(accountHome, name)), name);
      }
      assert.strictEqual(
        yield* fs.readFileString(path.join(sharedHome, "remote-settings.json")),
        "shared login",
      );
      assert.isTrue(Option.isNone(yield* fs.readLink(releasedLock).pipe(Effect.option)));
    }),
  );

  it.effect("keeps the account's MCP servers in step with the shared config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-" }));
      const sharedConfigPath = path.join(root, ".claude.json");
      const accountHome = path.join(root, "account", "home");
      const accountConfigPath = path.join(accountHome, ".claude.json");
      const writeJson = (file: string, value: unknown) =>
        encodeJson(value).pipe(Effect.flatMap((text) => fs.writeFileString(file, text)));
      const accountConfig = fs.readFileString(accountConfigPath).pipe(Effect.flatMap(decodeJson));
      const share = shareClaudeMcpServers({ sharedConfigPath, accountHome });
      yield* fs.makeDirectory(accountHome, { recursive: true });

      // Claude has not written the account's config yet.
      yield* writeJson(sharedConfigPath, {
        mcpServers: { docs: { type: "http", url: "https://a" } },
      });
      yield* share;
      assert.isFalse(yield* fs.exists(accountConfigPath));

      yield* writeJson(accountConfigPath, {
        oauthAccount: { emailAddress: "work@example.com" },
        mcpServers: {
          local: { type: "stdio", command: "own-server", args: [] },
          docs: { type: "http", url: "https://old" },
        },
      });
      yield* share;
      assert.deepStrictEqual(yield* accountConfig, {
        oauthAccount: { emailAddress: "work@example.com" },
        mcpServers: {
          docs: { type: "http", url: "https://a" },
          local: { type: "stdio", command: "own-server", args: [] },
        },
      });

      yield* writeJson(sharedConfigPath, {
        mcpServers: { tracker: { type: "http", url: "https://b" } },
      });
      yield* share;
      const expected = {
        oauthAccount: { emailAddress: "work@example.com" },
        mcpServers: {
          tracker: { type: "http", url: "https://b" },
          local: { type: "stdio", command: "own-server", args: [] },
        },
      };
      assert.deepStrictEqual(yield* accountConfig, expected);

      // A config Claude is halfway through writing copies nothing.
      yield* fs.writeFileString(sharedConfigPath, '{"mcpServers": {');
      yield* share;
      assert.deepStrictEqual(yield* accountConfig, expected);
    }),
  );
});
