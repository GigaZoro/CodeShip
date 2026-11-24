// `vp run check:changed` records each pass here, keyed by the tree it checked, and the tracked
// pre-push hook (.vite-hooks/pre-push) refuses a push to main whose tree has no pass that compared
// it with the commit main is at. Plain Node with no dependencies, so the hook needs no install.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { REAL_HISTORY_ENV, markedFiles } = require("./git-history.cjs");

const RECEIPT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const git = (cwd, args, env = process.env) =>
  execFileSync("git", args, {
    cwd,
    env: { ...env, ...REAL_HISTORY_ENV },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// Every worktree of a repository shares its git directory, so a pass in one worktree covers a push from another.
const receiptDirectory = (cwd) =>
  path.join(
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "t3-check-changed",
    "passed",
  );

// The tree a commit of everything check:changed reads would get, staged or not. A copy of the index
// keeps its stat cache. New objects go to a scratch directory: nothing references them, so in the
// repository they would pile up as loose garbage.
function workingTree(cwd) {
  const marked = markedFiles(cwd);
  if (marked.length > 0) {
    throw new Error(
      `check-changed: files marked assume-unchanged or skip-worktree would pass for the commit's content: ${marked.join(", ")}`,
    );
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-check-changed-index-"));
  try {
    const index = path.join(temp, "index");
    const real = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    if (fs.existsSync(real)) {
      // Git rereads a file whose cached stat matches only when the file is no older than the index, and a copy is new,
      // so the copy takes the index's time, floored to whole seconds, from the open file it copies. At or before the
      // epoch that floor fails (git ignores a zero time; division rounds a negative one up), so every file is hashed.
      const source = fs.openSync(real, "r");
      try {
        const second = Number(fs.fstatSync(source, { bigint: true }).mtimeNs / 1_000_000_000n);
        if (second > 0) {
          fs.writeFileSync(index, fs.readFileSync(source));
          fs.utimesSync(index, second, second);
        }
      } finally {
        fs.closeSync(source);
      }
    }
    const objects = path.join(temp, "objects");
    fs.mkdirSync(objects);
    const env = {
      ...process.env,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]),
    };
    // Shared indexes live in the repository, and the real index may still name one a scratch write would expire.
    const scratch = ["-c", "core.splitIndex=false", "-c", "splitIndex.sharedIndexExpire=never"];
    git(cwd, [...scratch, "add", "--all", "--", ":/"], env);
    return git(cwd, [...scratch, "write-tree"], env);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function recordPass(cwd, tree, base) {
  if (!OBJECT_ID.test(tree) || !OBJECT_ID.test(base)) {
    throw new Error(`check-changed-receipt: not object ids: ${tree} ${base}`);
  }
  const directory = receiptDirectory(cwd);
  fs.mkdirSync(directory, { recursive: true });
  const now = Date.now();
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > RECEIPT_DAYS * DAY_MS) fs.rmSync(file, { force: true });
  }
  fs.writeFileSync(path.join(directory, `${tree}.${base}`), "");
}

// Throws unless check:changed passed for `localSha`'s tree compared with `remoteSha`, the commit main is at:
// against an older main, a file main changed and the push changes back looks unchanged and goes unchecked.
// `remoteSha` is empty when the push creates the branch.
function requirePass(cwd, localSha, remoteSha) {
  const tree = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${localSha}^{tree}`]);
  const directory = receiptDirectory(cwd);
  const bases = (fs.existsSync(directory) ? fs.readdirSync(directory) : [])
    .filter((name) => name.startsWith(`${tree}.`))
    .map((name) => name.slice(tree.length + 1));
  const commit = localSha.slice(0, 12);
  if (bases.length === 0) {
    throw new Error(
      `Push to main refused: \`vp run check:changed\` has not passed for ${commit}'s tree. ` +
        "Run it in this checkout with that commit checked out and nothing else uncommitted or untracked, then push again.",
    );
  }
  if (!remoteSha || bases.includes(remoteSha)) return;
  throw new Error(
    `Push to main refused: \`vp run check:changed\` passed for ${commit}'s tree against ` +
      `${bases.map((base) => base.slice(0, 12)).join(", ")}, not main's current commit ` +
      `${remoteSha.slice(0, 12)}, so changes between them went unchecked. ` +
      "Land with `node .github/scripts/landing-turn.cjs land`, which checks against main's commit.",
  );
}

module.exports = { recordPass, requirePass, workingTree };

if (require.main === module) {
  try {
    const [command, localSha, remoteSha = "", ...rest] = process.argv.slice(2);
    if (command !== "verify" || !localSha || rest.length > 0) {
      throw new Error(
        "Usage: node .github/scripts/check-changed-receipt.cjs verify <local-sha> [<remote-sha>]",
      );
    }
    requirePass(process.cwd(), localSha, remoteSha);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
