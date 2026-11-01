// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction or a hard link to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** An added Claude account keeps its own login here; CodeShip creates the folder and links the rest. */
export const claudeAccountHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
) => path.join(stateDir, "providers", "claudeAgent", instanceId, "home");

// The login, account state and Anthropic-managed settings belong to one account.
const PRIVATE_ENTRIES = new Set([
  ".credentials.json",
  ".claude.json",
  "backups",
  "remote-settings.json",
  ".DS_Store",
]);
// Created in the shared folder first, so every account's sessions land in one place and threads can move between accounts.
const SHARED_DIRECTORIES = ["projects"];

/** Windows links folders with a junction, and files with a hard link when symlinks need elevation. */
export const linkPath = (
  target: string,
  link: string,
  platform: NodeJS.Platform,
  directory: boolean,
) =>
  Effect.tryPromise(async () => {
    if (directory) {
      await NodeFSP.symlink(target, link, platform === "win32" ? "junction" : "dir");
      return;
    }
    try {
      await NodeFSP.symlink(target, link, "file");
    } catch (error) {
      if (platform !== "win32") throw error;
      await NodeFSP.link(target, link);
    }
  });

/** Links everything in the shared Claude folder into the account's folder, except its login. */
export const materializeClaudeAccountHome = Effect.fn("materializeClaudeAccountHome")(
  function* (input: {
    readonly sharedHome: string;
    readonly accountHome: string;
  }): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const linkEntry = Effect.fn("ClaudeAccountHome.linkEntry")(function* (entry: string) {
      const target = path.join(input.sharedHome, entry);
      const link = path.join(input.accountHome, entry);
      const [current, expected] = yield* Effect.all([
        fileSystem.realPath(link).pipe(Effect.option),
        fileSystem.realPath(target).pipe(Effect.option),
      ]);
      if (Option.isSome(current) && Option.isSome(expected) && current.value === expected.value)
        return;
      const isLink = yield* fileSystem.readLink(link).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      // A real entry here was written by this account (or is a Windows hard link); keep it.
      if (Option.isSome(current) && !isLink) return;
      if (isLink) yield* fileSystem.remove(link);
      const info = yield* fileSystem.stat(target);
      yield* linkPath(target, link, platform, info.type === "Directory");
    });
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(input.accountHome, { recursive: true });
      for (const directory of SHARED_DIRECTORIES) {
        yield* fileSystem.makeDirectory(path.join(input.sharedHome, directory), {
          recursive: true,
        });
      }
      for (const entry of yield* fileSystem.readDirectory(input.sharedHome)) {
        if (PRIVATE_ENTRIES.has(entry)) continue;
        yield* linkEntry(entry).pipe(
          Effect.catch((error) =>
            Effect.logWarning("A shared Claude file is not linked into the account's folder.", {
              entry,
              error,
            }),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("The Claude account's folder could not be prepared.", {
          accountHome: input.accountHome,
          error,
        }),
      ),
    );
  },
);
