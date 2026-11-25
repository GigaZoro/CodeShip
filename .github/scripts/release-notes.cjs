const { isUtf8 } = require("node:buffer");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { GIT_OUTPUT_MAX_BYTES } = require("./git-history.cjs");

const NOTES_PATH = "docs/release-notes.md";
// .gitattributes names this driver for NOTES_PATH. `configure`, which `vp i` runs, sets it for manual rebases and
// merges; the landing turn passes it to its own rebase.
const MERGE_DRIVER = "release-notes";
const MERGE_DRIVER_CONFIG = [
  [`merge.${MERGE_DRIVER}.driver`, "node .github/scripts/release-notes.cjs merge %O %A %B"],
];

function splitEntries(text) {
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/(?=^## )/m)
    .map((entry) => entry.trim());
}

function parseReleaseNotes(text) {
  const entries = splitEntries(text);
  const headings = new Set();
  let previousDate = "9999-12-31";
  for (const entry of entries) {
    const [heading] = entry.split("\n");
    const match = /^## (\d{4}-\d{2}-\d{2}) — (\S.*)$/.exec(heading);
    if (!match || !/^- \S/m.test(entry)) {
      throw new Error(
        `${NOTES_PATH}: each entry needs '## YYYY-MM-DD — Title' and change bullets.`,
      );
    }
    const date = match[1];
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`${NOTES_PATH}: invalid date ${date}.`);
    }
    if (date > previousDate || headings.has(heading)) {
      throw new Error(`${NOTES_PATH}: put newest entries first and use a unique dated title.`);
    }
    previousDate = date;
    headings.add(heading);
  }
  return entries;
}

function addedReleaseNotes(current, previous) {
  const entries = parseReleaseNotes(current);
  if (previous === null) return entries;
  // Matched by content, not position, so a shipment can move an entry back into date order.
  const oldEntries = new Set(splitEntries(previous));
  const added = entries.filter((entry) => !oldEntries.has(entry));
  if (entries.length - added.length !== oldEntries.size) {
    throw new Error(`${NOTES_PATH}: preserve existing entries and prepend new notes.`);
  }
  return added;
}

function requireNewReleaseNotes(current, previous) {
  const added = addedReleaseNotes(current, previous);
  if (added.length === 0) {
    throw new Error(`${NOTES_PATH}: prepend a dated summary before shipping this change to main.`);
  }
  return added;
}

const entriesOf = (text) => (text.trim() ? parseReleaseNotes(text) : []);
const entryDate = (entry) => entry.slice(3, 13);
const entryHeading = (entry) => entry.split("\n", 1)[0];
const entryTitle = (entry) => entryHeading(entry).slice("## YYYY-MM-DD — ".length);
const entryBody = (entry) => entry.slice(entryHeading(entry).length).trim();

/**
 * `side`'s entries with `additions`' new ones, each between the entries around it in `additions` and in date order, as
 * high as that allows when `onTop`, else as low. Null when they leave no place, when a new entry shares a heading, title
 * or text with one only `side` added or changed (one shipment under two dates), or when no entry would be left. An entry
 * both add is one shipment picked twice only when `side` holds every base entry: else `side` may have rewritten one.
 */
function insertNewEntries(side, additions, known, sideHoldsBase, onTop) {
  const merged = [...side];
  const headings = merged.map(entryHeading);
  const byHeading = new Map(merged.map((entry, index) => [headings[index], entry]));
  const additionHeadings = additions.map(entryHeading);
  const shared = new Set(additions);
  const sideOnly = side.filter((entry) => !known.has(entry) && !shared.has(entry));
  const sideTitles = new Set(sideOnly.map(entryTitle));
  const sideBodies = new Set(sideOnly.map(entryBody));
  for (const [position, entry] of additions.entries()) {
    const heading = additionHeadings[position];
    const present = byHeading.get(heading);
    if (present !== undefined) {
      if (!known.has(entry) && (present !== entry || !sideHoldsBase)) return null;
      continue;
    }
    if (known.has(entry)) continue;
    if (sideTitles.has(entryTitle(entry)) || sideBodies.has(entryBody(entry))) return null;
    const indexes = new Map(headings.map((other, index) => [other, index]));
    const placed = (from, to) =>
      additionHeadings
        .slice(from, to)
        .map((other) => indexes.get(other))
        .filter((index) => index !== undefined);
    const after = Math.max(-1, ...placed(0, position));
    const before = Math.min(merged.length, ...placed(position + 1));
    if (after >= before) return null;
    const date = entryDate(entry);
    let top = after + 1;
    while (top < before && entryDate(merged[top]) > date) top += 1;
    let bottom = before;
    while (bottom > top && entryDate(merged[bottom - 1]) < date) bottom -= 1;
    const index = onTop ? top : bottom;
    merged.splice(index, 0, entry);
    headings.splice(index, 0, heading);
    byHeading.set(heading, entry);
  }
  return merged.length > 0 ? `${merged.join("\n\n")}\n` : null;
}

/**
 * Merges when only one side changed, dropped or reordered `base`'s entries: the other side's new entries go into its
 * notes, `theirs`' above `ours`' of one date where the entries around them allow it. Landings on main keep entries word
 * for word, so a branch that rewords its own entry later still rebases onto them unless one shares its title or text.
 * Null, for git's text merge, when both sides changed `base`'s entries or a new entry cannot be placed.
 */
function mergeReleaseNotes(base, ours, theirs) {
  const baseEntries = entriesOf(base);
  const known = new Set(baseEntries);
  const kept = (entries) => entries.filter((entry) => known.has(entry));
  const holdsBase = (entries) => kept(entries).length === baseEntries.length;
  const keepsBase = (entries) =>
    kept(entries).every((entry, index) => entry === baseEntries[index]);
  const ourEntries = entriesOf(ours);
  const theirEntries = entriesOf(theirs);
  if (holdsBase(theirEntries) && keepsBase(theirEntries)) {
    return insertNewEntries(ourEntries, theirEntries, known, holdsBase(ourEntries), true);
  }
  if (holdsBase(ourEntries) && keepsBase(ourEntries)) {
    return insertNewEntries(theirEntries, ourEntries, known, holdsBase(theirEntries), false);
  }
  return null;
}

/** git's merge driver: writes the merge over `oursPath` and exits 0, or non-zero with conflict markers. */
function mergeFiles(basePath, oursPath, theirsPath) {
  // Decoding would turn a byte that is not UTF-8 into U+FFFD, so such notes take git's text merge.
  const read = (file) => {
    const bytes = fs.readFileSync(file);
    if (!isUtf8(bytes)) throw new Error(`${NOTES_PATH}: a side is not UTF-8.`);
    return bytes.toString("utf8");
  };
  let merged = null;
  try {
    merged = mergeReleaseNotes(read(basePath), read(oursPath), read(theirsPath));
  } catch (error) {
    process.stderr.write(`${error.message} Merging it as text.\n`);
  }
  if (merged !== null) {
    fs.writeFileSync(oursPath, merged);
    return 0;
  }
  const labels = ["-L", "current", "-L", "base", "-L", "incoming"];
  const text = spawnSync("git", ["merge-file", ...labels, oursPath, basePath, theirsPath], {
    stdio: "inherit",
  });
  return text.status ?? 1;
}

/**
 * Why rebases and merges in `cwd` would not merge NOTES_PATH with the driver, or null. The script that asks comes from
 * a tree whose .gitattributes names the driver, so any other value, unspecified included, is a local override.
 */
function notesMergeProblem(cwd, env = process.env) {
  const git = (dir, ...args) => {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env,
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    // A path can end in a space, so only the line break goes.
    return result.stdout.replace(/\n$/, "");
  };
  // check-attr reads the path from the directory it runs in.
  const top = git(cwd, "rev-parse", "--show-toplevel");
  const value = git(top, "check-attr", "-z", "merge", "--", NOTES_PATH).split("\0")[2];
  if (value === MERGE_DRIVER) return null;
  // No `-c` option overrides this file, the usual source of such a rule.
  const local = path.resolve(top, git(top, "rev-parse", "--git-path", "info/attributes"));
  const merge = value === "unspecified" ? "no merge attribute" : `the merge attribute \`${value}\``;
  return `release-notes: rebases and merges here merge ${NOTES_PATH} with ${merge} instead of its driver, which can break its entries. Keep its line in .gitattributes, and remove any line for it from ${local}, which outranks .gitattributes.`;
}

function configureMergeDriver(root) {
  const localVars = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  });
  if (localVars.status !== 0) return;
  // A hook or wrapper can export another repository's location; find the one at `root` instead. Windows reads
  // these names in any case.
  const selectors = new Set(localVars.stdout.split("\n"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !selectors.has(name.toUpperCase())),
  );
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", env, maxBuffer: GIT_OUTPUT_MAX_BYTES });
  // An unpacked source archive has no repository of its own; the one around it, if any, is not ours to configure.
  if (git("rev-parse", "--is-inside-work-tree", "--show-prefix").stdout !== "true\n\n") return;
  for (const [key, value] of MERGE_DRIVER_CONFIG) {
    // Worktrees share this config, so a setup running in another one can hold its lock.
    if (git("config", "--local", "--get", key).stdout.trim() !== value) {
      const set = git("config", "--local", "--replace-all", key, value);
      if (set.status !== 0) {
        process.stderr.write(`release-notes: could not set ${key}: ${set.stderr.trim()}\n`);
      }
    }
    // A worktree's own config, for one, wins over the repository's.
    const [origin, effective = ""] = git("config", "--show-origin", "--get", key)
      .stdout.trim()
      .split("\t");
    if (effective !== value) {
      const merge = effective
        ? `\`${effective}\` from ${origin}; fix ${key} there`
        : "git's text merge";
      process.stderr.write(
        `release-notes: rebases and merges here merge ${NOTES_PATH} with ${merge}. Run \`node .github/scripts/release-notes.cjs configure\` again to merge it by date.\n`,
      );
    }
  }
  let problem;
  try {
    problem = notesMergeProblem(root, env);
  } catch (error) {
    problem = `release-notes: ${error.message}`;
  }
  if (problem) process.stderr.write(`${problem}\n`);
}

function readNotesAt(root, ref) {
  if (!ref) return null;
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    }).trim();
  const commit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  if (!git("ls-tree", "--name-only", commit, "--", NOTES_PATH)) return null;
  return git("show", `${commit}:${NOTES_PATH}`);
}

function report(root, command, base, head) {
  const current = head
    ? (readNotesAt(root, head) ?? "")
    : fs.readFileSync(path.join(root, NOTES_PATH), "utf8");
  const previous = readNotesAt(root, base);
  if (command === "check") {
    requireNewReleaseNotes(current, previous);
    process.stdout.write("Release notes: valid new entry.\n");
  } else {
    const added = addedReleaseNotes(current, previous);
    process.stdout.write(
      `${(added.length ? added : parseReleaseNotes(current).slice(0, 1)).join("\n\n")}\n`,
    );
  }
}

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const root = path.resolve(__dirname, "../..");
    if (command === "merge" && args.length === 3) process.exitCode = mergeFiles(...args);
    else if (command === "configure" && args.length === 0) configureMergeDriver(root);
    else if (["check", "render"].includes(command) && args.length <= 2) {
      report(root, command, ...args);
    } else {
      throw new Error(
        "Usage: node .github/scripts/release-notes.cjs check|render [base-ref] [head-ref] | merge <base> <ours> <theirs> | configure",
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  MERGE_DRIVER_CONFIG,
  addedReleaseNotes,
  mergeReleaseNotes,
  notesMergeProblem,
  requireNewReleaseNotes,
};
