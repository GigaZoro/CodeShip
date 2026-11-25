import { GitCommandError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

// Git does not run post-checkout for a metadata-only add. Keep the obligation in the
// linked checkout's private admin directory until its hook has returned successfully.
import { existingWorkspacePath } from "../workspace/workspaceLease.ts";

export const pendingFamilyCheckoutHook = "codeship-family-checkout-pending";
export const runningFamilyCheckoutHook = "codeship-family-checkout-hook.lock";

export const familyHookUnavailable =
  "Cannot verify Git's built-in hook command for family worktree recovery (requires Git 2.36 or later).";

export const supportsFamilyCheckoutHook = <R>(
  runGit: (args: string[]) => Effect.Effect<string, GitCommandError, R>,
) =>
  // Git lists these command names without localization, aliases or external git-* commands.
  runGit(["--list-cmds=builtins"]).pipe(
    Effect.match({ onFailure: () => false, onSuccess: (list) => /(?:^|\n)hook\r?\n/.test(list) }),
  );

export const familyHookOperation = "GitVcsDriver.familyCheckoutHook";

const hookError = (cwd: string, detail: string) =>
  new GitCommandError({ operation: familyHookOperation, command: "git hook run", cwd, detail });

export const unconfirmedFamilyHook = (cwd: string, running: string) =>
  hookError(
    cwd,
    `Git did not confirm the post-checkout hook's exit in ${cwd}. Check for a live hook and inspect its effects. Recovery is held by ${running}.`,
  );

const readRecord = Effect.fn("GitVcsDriver.readFamilyCheckoutHook")(function* (
  file: string,
  contents: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if ((yield* existingWorkspacePath(file)) !== file) return null;
  const stat = yield* fs.stat(file);
  if (stat.type !== "File" || Number(stat.size) > Buffer.byteLength(contents) + 21) return null;
  return yield* fs.readFileString(file);
});

export const requireUnstartedFamilyHook = Effect.fn("GitVcsDriver.requireUnstartedFamilyHook")(
  function* (cwd: string, waiting: string, head: string) {
    const contents = head + "\n" + (yield* existingWorkspacePath(cwd));
    if ((yield* readRecord(waiting, contents)) !== contents)
      return yield* hookError(
        cwd,
        `Git cannot repair missing tracked files in ${cwd} after its post-checkout hook may have changed them. Inspect the checkout and its pending record at ${waiting} before sending a new follow-up.`,
      );
  },
);

export const familyCheckoutHook = Effect.fn(familyHookOperation)(function* (
  cwd: string,
  admin: string,
  head: string,
  operation: "prepare" | "finish",
  runGit: (args: string[]) => Effect.Effect<string, GitCommandError>,
  followUpAt?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = head + "\n" + (yield* existingWorkspacePath(cwd));
  const waiting = path.join(admin, pendingFamilyCheckoutHook);
  const running = path.join(admin, runningFamilyCheckoutHook);
  const failed = (code: number) =>
    hookError(
      cwd,
      `Git post-checkout exited with ${code} in ${cwd}. Inspect the hook and its changes before sending a new follow-up to retry it. The pending record is ${waiting}.`,
    );
  const files = yield* fs.readDirectory(admin);
  if (files.includes(runningFamilyCheckoutHook)) return yield* unconfirmedFamilyHook(cwd, running);
  if (files.includes("locked") || files.some((file) => file.endsWith(".lock")))
    return yield* hookError(cwd, "The restored checkout is locked.");
  if (!files.includes(pendingFamilyCheckoutHook)) {
    if (operation === "prepare")
      yield* fs.writeFileString(waiting, contents, { flag: "wx", mode: 0o600 });
    return;
  }
  const record = yield* readRecord(waiting, contents);
  if (record !== contents) {
    const failure =
      record?.startsWith(contents) &&
      /^\0([1-9]\d{0,2})\0(\d{1,16})$/.exec(record.slice(contents.length));
    if (
      !failure ||
      contents + failure[0] !== record ||
      Number(failure[1]) >= 128 ||
      !Number.isSafeInteger(Number(failure[2]))
    )
      return yield* hookError(cwd, `The pending post-checkout hook record changed at ${waiting}.`);
    if (
      !Number.isSafeInteger(followUpAt) ||
      followUpAt === undefined ||
      followUpAt <= Number(failure[2])
    )
      return yield* failed(Number(failure[1]));
  }
  if (operation === "prepare") return;
  if (!(yield* supportsFamilyCheckoutHook(runGit)))
    return yield* hookError(cwd, familyHookUnavailable);

  yield* fs.writeFileString(running, contents, { flag: "wx", mode: 0o600 });
  yield* fs.remove(waiting);
  const result = yield* Effect.result(
    runGit([
      "hook",
      "run",
      "--ignore-missing",
      "post-checkout",
      "--",
      "0".repeat(head.length),
      head,
      "1",
    ]),
  );
  if ((yield* readRecord(running, contents)) !== contents)
    return yield* hookError(cwd, `The active post-checkout hook record changed at ${running}.`);
  if (Result.isFailure(result)) {
    const code = result.failure.exitCode;
    // Git uses 128 + signal for a killed hook. Its effects cannot safely be replayed.
    if (code === undefined || !Number.isInteger(code) || code <= 0 || code >= 128)
      return yield* unconfirmedFamilyHook(cwd, running);
    // A queued turn and an automatic retry can both arrive after the hook finishes. Require
    // a fresh user message dated after failure before replaying a hook with possible side effects.
    const failedAt = Math.max(yield* Clock.currentTimeMillis, followUpAt ?? 0);
    yield* fs.writeFileString(waiting, `${contents}\0${code}\0${failedAt}`, {
      flag: "wx",
      mode: 0o600,
    });
    yield* fs.remove(running);
    return yield* failed(code);
  }
  yield* fs.remove(running);
});
