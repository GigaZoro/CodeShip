// What the landing's git calls read. A replace ref or a graft changes the history a checkout shows but not the one a
// push sends, so every call that decides what may land reads the real one. Git opens no file under /dev/null (\dev\null
// on Windows), so it reads no grafts and prints none of the deprecation hint an empty graft file brings.
const { spawnSync } = require("node:child_process");

const REAL_HISTORY_ENV = Object.freeze({
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_GRAFT_FILE: "/dev/null/grafts",
});

// `ls-files -v` prints 2 MB for this repository, past spawnSync's 1 MiB default.
const LS_FILES_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Tracked files marked assume-unchanged (lowercase tag) or skip-worktree (`S`): `status` does not list their edits, so
 * a tree checked from the worktree can differ from the commit it is pushed as.
 */
function markedFiles(cwd) {
  const listed = spawnSync("git", ["-C", cwd, "ls-files", "-v"], {
    encoding: "utf8",
    env: { ...process.env, ...REAL_HISTORY_ENV },
    maxBuffer: LS_FILES_MAX_BYTES,
    windowsHide: true,
  });
  if (listed.error) throw listed.error;
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  return listed.stdout
    .split("\n")
    .filter((line) => /^[a-zS] /.test(line))
    .map((line) => line.slice(2));
}

module.exports = { REAL_HISTORY_ENV, markedFiles };
