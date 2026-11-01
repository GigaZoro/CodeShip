import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { materializeClaudeAccountHome } from "./ClaudeAccountHome.ts";

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
      for (const name of [".credentials.json", ".claude.json", "remote-settings.json"]) {
        yield* fs.writeFileString(path.join(sharedHome, name), "shared login");
      }
      yield* fs.makeDirectory(path.join(sharedHome, "backups"));
      yield* fs.makeDirectory(accountHome, { recursive: true });
      yield* fs.writeFileString(path.join(accountHome, "settings.json"), "account's own");
      yield* fs.symlink(path.join(root, "elsewhere"), path.join(accountHome, "CLAUDE.md"));

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
      for (const name of [".credentials.json", ".claude.json", "remote-settings.json", "backups"]) {
        assert.isFalse(yield* fs.exists(path.join(accountHome, name)), name);
      }
    }),
  );
});
