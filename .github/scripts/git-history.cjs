// What the landing's git calls read. A replace ref or a graft changes the history a checkout shows but not the one a
// push sends, so every call that decides what may land reads the real one. Git opens no file under /dev/null (\dev\null
// on Windows), so it reads no grafts and prints none of the deprecation hint an empty graft file brings.
const { spawnSync } = require("node:child_process");

const REAL_HISTORY_ENV = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: "/dev/null/grafts",
});

// Past spawnSync's and execFileSync's 1 MiB default: Git prints a line per path for `ls-files`, `status` and a merge's
// conflicts, where this repository's paths alone take 2 MB, and `show` prints the release notes, which grow each day.
const GIT_OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Tracked files marked assume-unchanged (lowercase tag) or skip-worktree (`S`): `status` does not list their edits, so
 * a tree checked from the worktree can differ from the commit it is pushed as.
 */
function markedFiles(cwd) {
  const listed = spawnSync("git", ["-C", cwd, "ls-files", "-v"], {
    encoding: "utf8",
    env: { ...process.env, ...REAL_HISTORY_ENV },
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
    windowsHide: true,
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  return listed.stdout
    .split("\n")
    .filter((line) => /^[a-zS] /.test(line))
    .map((line) => line.slice(2));
}

module.exports = { GIT_OUTPUT_MAX_BYTES, REAL_HISTORY_ENV, markedFiles };
