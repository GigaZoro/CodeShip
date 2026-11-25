import { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// Git does not run post-checkout for a metadata-only add. Keep the obligation in the
// linked checkout's private admin directory until its hook has returned successfully.
import { existingWorkspacePath } from "../workspace/workspaceLease.ts";

export const pendingFamilyCheckoutHook = "codeship-family-checkout-pending";
export const runningFamilyCheckoutHook = "codeship-family-checkout-hook.lock";

export const familyCheckoutHook = Effect.fn("GitVcsDriver.familyCheckoutHook")(function* (
  cwd: string,
  admin: string,
  head: string,
  operation: "prepare" | "finish",
  runGit: (args: string[]) => Effect.Effect<void, GitCommandError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = head + "\n" + (yield* existingWorkspacePath(cwd));
  const waiting = path.join(admin, pendingFamilyCheckoutHook);
  const running = path.join(admin, runningFamilyCheckoutHook);
  const refuse = (detail: string) =>
    new GitCommandError({
      operation: "GitVcsDriver.familyCheckoutHook",
      command: "git hook run",
      cwd,
      detail,
    });
  const files = yield* fs.readDirectory(admin);
  if (files.includes("locked") || files.some((file) => file.endsWith(".lock")))
    return yield* refuse(
      "The checkout is locked or its previous post-checkout hook may still be running.",
    );
  const matches = Effect.fn("GitVcsDriver.matchesFamilyCheckoutHook")(function* (file: string) {
    if ((yield* existingWorkspacePath(file)) !== file) return false;
    const stat = yield* fs.stat(file);
    return (
      stat.type === "File" &&
      Number(stat.size) === Buffer.byteLength(contents) &&
      (yield* fs.readFileString(file)) === contents
    );
  });
  if (!files.includes(pendingFamilyCheckoutHook)) {
    if (operation === "prepare")
      yield* fs.writeFileString(waiting, contents, { flag: "wx", mode: 0o600 });
    return;
  }
  if (!(yield* matches(waiting)))
    return yield* refuse("The pending post-checkout hook record changed.");
  if (operation === "prepare") return;
  // The lease excludes other CodeShip starters. Any failed or interrupted hook retains
  // the running record, since its user-defined commands cannot safely be replayed.
  yield* fs.writeFileString(running, contents, { flag: "wx", mode: 0o600 });
  yield* fs.remove(waiting);
  yield* runGit([
    "hook",
    "run",
    "--ignore-missing",
    "post-checkout",
    "--",
    "0".repeat(head.length),
    head,
    "1",
  ]);
  if (!(yield* matches(running)))
    return yield* refuse("The active post-checkout hook record changed.");
  yield* fs.remove(running);
});
