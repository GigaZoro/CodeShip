import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PromptFileReader from "./PromptFileReader.ts";

const layerTest = PromptFileReader.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-prompt-file-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "PromptFileReader.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-prompt-file-" });
});

/** Writes `files` in the author's checkout, commits and pushes them to the default branch. */
const push = (author: string, files: Readonly<Record<string, string | Uint8Array>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(author, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* typeof content === "string"
        ? fs.writeFileString(file, content)
        : fs.writeFile(file, content);
    }
    yield* git(author, ["add", "."]);
    yield* git(author, ["commit", "-m", "update prompts"]);
    yield* git(author, ["push", "origin", "trunk"]);
    return yield* git(author, ["rev-parse", "HEAD"]);
  });

/**
 * A remote whose default branch is `trunk`, an author who pushes to it, and the project's own
 * clone, which never pulls.
 */
const setup = Effect.gen(function* () {
  const origin = yield* tempDir;
  const author = yield* tempDir;
  const project = yield* tempDir;
  yield* git(origin, ["init", "--bare", "--initial-branch=trunk"]);
  yield* git(author, ["init", "--initial-branch=trunk"]);
  yield* git(author, ["config", "user.email", "test@test.com"]);
  yield* git(author, ["config", "user.name", "Test"]);
  yield* git(author, ["remote", "add", "origin", origin]);
  yield* push(author, {
    "automations/daily.md": "﻿  Run the daily check ✓.\n",
    "automations/empty.md": " \n",
    // "café" in Latin-1, which is not UTF-8.
    "automations/latin1.md": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    "README.md": "# test\n",
  });
  yield* git(project, ["clone", origin, "."]);
  return { author, project };
});

it.effect("reads a prompt file from the tip of the remote's default branch", () =>
  Effect.gen(function* () {
    const reader = yield* PromptFileReader.PromptFileReader;
    const { author, project } = yield* setup;
    const tracking = yield* git(project, ["rev-parse", "refs/remotes/origin/trunk"]);

    const first = yield* reader.read({ cwd: project, path: "automations/daily.md" });
    assert.deepEqual(first, {
      text: "Run the daily check ✓.",
      ref: "origin/trunk",
      commit: yield* git(author, ["rev-parse", "HEAD"]),
    });

    // Pushed after the project was cloned, which never pulls it.
    const pushed = yield* push(author, { "automations/daily.md": "Run the new check.\n" });
    assert.deepEqual(yield* reader.read({ cwd: project, path: "automations/daily.md" }), {
      text: "Run the new check.",
      ref: "origin/trunk",
      commit: pushed,
    });
    // Reads fetch into refs of their own and drop them, so the user's refs stay as they were.
    assert.equal(yield* git(project, ["rev-parse", "refs/remotes/origin/trunk"]), tracking);
    assert.equal(yield* git(project, ["for-each-ref", "refs/t3"]), "");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.each([
  {
    path: "automations/missing.md",
    message:
      "Could not read the prompt file automations/missing.md from origin/trunk: it does not exist there.",
  },
  {
    path: "automations",
    message: "Could not read the prompt file automations from origin/trunk: it is a folder.",
  },
  {
    path: "automations/empty.md",
    message: "Could not read the prompt file automations/empty.md from origin/trunk: it is empty.",
  },
  {
    path: "automations/latin1.md",
    message:
      "Could not read the prompt file automations/latin1.md from origin/trunk: it is not UTF-8 text.",
  },
])("refuses $path, naming the file and the branch", ({ path, message }) =>
  Effect.gen(function* () {
    const reader = yield* PromptFileReader.PromptFileReader;
    const { project } = yield* setup;

    const error = yield* reader.read({ cwd: project, path }).pipe(Effect.flip);
    assert.equal(error.message, message);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("refuses a folder that is not a git repository", () =>
  Effect.gen(function* () {
    const reader = yield* PromptFileReader.PromptFileReader;
    const folder = yield* tempDir;

    const error = yield* reader
      .read({ cwd: folder, path: "automations/daily.md" })
      .pipe(Effect.flip);
    assert.equal(error.ref, null);
    assert.match(
      error.message,
      /^Could not read the prompt file automations\/daily\.md from the remote's default branch: /u,
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
