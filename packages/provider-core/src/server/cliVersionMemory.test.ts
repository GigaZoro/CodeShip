import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { type CliVersionMemory, makeCliVersionMemory } from "./cliVersionMemory.ts";
import * as ProviderHost from "./ProviderHost.ts";

const instanceId = ProviderInstanceId.make("claude_work");
const driver = ProviderDriverKind.make("claudeAgent");

const makeCacheDir = Effect.fn("makeCacheDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-version-memory-" });
});

// Leaves `contents` where a restarted instance looks for the version it recorded.
const leaveRecord = Effect.fn("leaveRecord")(function* (cacheDir: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(cacheDir, "cli-versions");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(path.join(directory, `${instanceId}.json`), contents);
});

const makeMemory = Effect.fn("makeMemory")(function* (cacheDir: string) {
  const path = yield* Path.Path;
  return yield* makeCliVersionMemory({ instanceId, driver }).pipe(
    Effect.provideService(
      ProviderHost.ProviderHost,
      ProviderHost.ProviderHost.of({
        paths: {
          cwd: process.cwd(),
          baseDir: path.dirname(cacheDir),
          stateDir: path.dirname(cacheDir),
          providerStatusCacheDir: cacheDir,
          attachmentsDir: path.dirname(cacheDir),
        },
        settings: {
          get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
          changes: Stream.empty,
          subscribe: Effect.succeed(Stream.empty),
        },
        shouldRunBackgroundWork: () => Effect.succeed(true),
        resolveAttachmentPath: () => null,
        credentials: () => Effect.die("unused"),
      }),
    ),
  );
});

// What the check saw as the last known version, while it reports `reported`.
const checkReporting = (memory: CliVersionMemory, reported: string | null) =>
  memory.check((lastKnownVersion) => Effect.succeed({ version: reported, lastKnownVersion }));

it.layer(NodeServices.layer)("makeCliVersionMemory", (it) => {
  it.effect.each([
    {
      scenario: "the version it recorded",
      record: JSON.stringify({ driver: "claudeAgent", version: "2.1.319" }),
      expected: "2.1.319",
    },
    {
      scenario: "a version another driver recorded",
      record: JSON.stringify({ driver: "codex", version: "0.98.0" }),
      expected: null,
    },
    { scenario: "no record", record: undefined, expected: null },
    { scenario: "an unreadable record", record: "{ not json", expected: null },
  ])("starts a restarted instance from $scenario", ({ record, expected }) =>
    Effect.gen(function* () {
      const cacheDir = yield* makeCacheDir();
      if (record !== undefined) {
        yield* leaveRecord(cacheDir, record);
      }
      const memory = yield* makeMemory(cacheDir);
      assert.strictEqual(yield* memory.lastKnownVersion, expected);
      assert.strictEqual((yield* checkReporting(memory, null)).lastKnownVersion, expected);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the newest reported version through checks and restarts that report none", () =>
    Effect.gen(function* () {
      const cacheDir = yield* makeCacheDir();
      // Closing the instance's scope waits for the versions it is still writing.
      yield* Effect.gen(function* () {
        const memory = yield* makeMemory(cacheDir);
        yield* checkReporting(memory, "2.2.0");
        yield* checkReporting(memory, "2.3.0");
        yield* checkReporting(memory, null);
        assert.strictEqual((yield* checkReporting(memory, null)).lastKnownVersion, "2.3.0");
      }).pipe(Effect.scoped);

      const restarted = yield* makeMemory(cacheDir);
      assert.strictEqual(yield* restarted.lastKnownVersion, "2.3.0");
    }).pipe(Effect.scoped),
  );

  it.effect("records the version again when the next check reports it after a failed write", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* makeCacheDir();
      // A file where the records' folder belongs fails the first write.
      const blocker = path.join(cacheDir, "cli-versions");
      yield* fs.writeFileString(blocker, "");
      let writeFailedLogged = () => {};
      const writeFailed = new Promise<void>((resolve) => {
        writeFailedLogged = resolve;
      });
      const logger = Logger.make(({ message }) => {
        if (Array.isArray(message) && message.includes("Could not record the CLI version.")) {
          writeFailedLogged();
        }
      });
      yield* Effect.gen(function* () {
        const memory = yield* makeMemory(cacheDir);
        yield* checkReporting(memory, "2.2.0");
        yield* Effect.promise(() => writeFailed);
        yield* fs.remove(blocker);
        yield* checkReporting(memory, "2.2.0");
      }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger])));

      const restarted = yield* makeMemory(cacheDir);
      assert.strictEqual(yield* restarted.lastKnownVersion, "2.2.0");
    }).pipe(Effect.scoped),
  );
});
