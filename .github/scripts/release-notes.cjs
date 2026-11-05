const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const NOTES_PATH = "docs/release-notes.md";

function parseReleaseNotes(text) {
  const source = text.replace(/\r\n/g, "\n").trim();
  const entries = source.split(/(?=^## )/m);
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
  return entries.map((entry) => entry.trim());
}

function addedReleaseNotes(current, previous) {
  const entries = parseReleaseNotes(current);
  if (previous === null) return entries;
  const oldEntries = parseReleaseNotes(previous);
  const addedCount = entries.length - oldEntries.length;
  if (
    addedCount < 0 ||
    entries.slice(addedCount).some((entry, index) => entry !== oldEntries[index])
  ) {
    throw new Error(`${NOTES_PATH}: preserve existing entries and prepend new notes.`);
  }
  return entries.slice(0, addedCount);
}

function requireNewReleaseNotes(current, previous) {
  const added = addedReleaseNotes(current, previous);
  if (added.length === 0) {
    throw new Error(`${NOTES_PATH}: prepend a dated summary before shipping this change to main.`);
  }
  return added;
}

function readPrevious(root, base) {
  if (!base) return null;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = git("rev-parse", "--verify", "--end-of-options", `${base}^{commit}`);
  if (!git("ls-tree", "--name-only", commit, "--", NOTES_PATH)) return null;
  return git("show", `${commit}:${NOTES_PATH}`);
}

if (require.main === module) {
  try {
    const [command, base, ...rest] = process.argv.slice(2);
    if (!["check", "render"].includes(command) || rest.length > 0) {
      throw new Error("Usage: node .github/scripts/release-notes.cjs check|render [base-ref]");
    }
    const root = path.resolve(__dirname, "../..");
    const current = fs.readFileSync(path.join(root, NOTES_PATH), "utf8");
    const previous = readPrevious(root, base);
    if (command === "check") {
      requireNewReleaseNotes(current, previous);
      process.stdout.write("Release notes: valid new entry.\n");
    } else {
      const added = addedReleaseNotes(current, previous);
      process.stdout.write(
        `${(added.length ? added : parseReleaseNotes(current).slice(0, 1)).join("\n\n")}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { addedReleaseNotes, requireNewReleaseNotes };
