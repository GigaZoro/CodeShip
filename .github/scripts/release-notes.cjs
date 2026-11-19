const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const NOTES_PATH = "docs/release-notes.md";
// .gitattributes names this driver for NOTES_PATH. `configure`, which `vp i` runs, sets it for manual rebases and
// merges; the landing turn passes it to its own rebase.
const MERGE_DRIVER_CONFIG = [
  ["merge.release-notes.driver", "node .github/scripts/release-notes.cjs merge %O %A %B"],
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

/**
 * The entries `theirs` added since `base`, placed among `ours` by date and after every entry that precedes them in
 * `theirs`, so a rebase or merge over another shipment's notes keeps both whole and newest first. Null when `theirs`
 * changed, dropped or reordered an existing entry or reuses a title `ours` has: git then merges the file as text.
 */
function mergeReleaseNotes(base, ours, theirs) {
  const baseEntries = entriesOf(base);
  const known = new Set(baseEntries);
  const theirEntries = entriesOf(theirs);
  const kept = theirEntries.filter((entry) => known.has(entry));
  if (
    kept.length !== baseEntries.length ||
    kept.some((entry, index) => entry !== baseEntries[index])
  ) {
    return null;
  }
  const merged = entriesOf(ours);
  const headings = new Set(merged.map(entryHeading));
  let floor = 0;
  for (const entry of theirEntries) {
    const at = merged.indexOf(entry);
    if (at >= 0) {
      floor = Math.max(floor, at + 1);
    } else if (!known.has(entry)) {
      if (headings.has(entryHeading(entry))) return null;
      const next = merged.findIndex(
        (other, index) => index >= floor && entryDate(other) <= entryDate(entry),
      );
      const index = next < 0 ? merged.length : next;
      merged.splice(index, 0, entry);
      floor = index + 1;
    }
  }
  return `${merged.join("\n\n")}\n`;
}

/** git's merge driver: writes the merge over `oursPath` and exits 0, or non-zero with conflict markers. */
function mergeFiles(basePath, oursPath, theirsPath) {
  const read = (file) => fs.readFileSync(file, "utf8");
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

function configureMergeDriver(root) {
  const localVars = spawnSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" });
  if (localVars.status !== 0) return;
  // A hook or wrapper can export another repository's location; find the one at `root` instead. Windows reads
  // these names in any case.
  const selectors = new Set(localVars.stdout.split("\n"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !selectors.has(name.toUpperCase())),
  );
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env });
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
}

function readNotesAt(root, ref) {
  if (!ref) return null;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
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
  requireNewReleaseNotes,
};
