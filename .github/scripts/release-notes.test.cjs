const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { addedReleaseNotes, requireNewReleaseNotes } = require("./release-notes.cjs");

const old = "## 2026-11-04 — Earlier change\n\n- Existing behavior.\n";
const latest = "## 2026-11-05 — New change\n\n- New behavior.\n";
const combined = `${latest}\n${old}`;

test("checks actual git history and fails closed when the base cannot be read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  try {
    fs.mkdirSync(path.join(root, ".github/scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.copyFileSync(__dirname + "/release-notes.cjs", root + "/.github/scripts/release-notes.cjs");
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    const run = (...args) =>
      spawnSync(process.execPath, [".github/scripts/release-notes.cjs", ...args], {
        cwd: root,
        encoding: "utf8",
      });
    const commit = () => {
      git("add", ".");
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=",
        "commit",
        "-m",
        "fixture",
      );
    };
    git("init");
    commit();
    fs.writeFileSync(path.join(root, "docs/release-notes.md"), old);
    assert.equal(run("check", "HEAD").status, 0);
    commit();
    assert.equal(run("check", "HEAD").status, 1);
    fs.writeFileSync(path.join(root, "docs/release-notes.md"), combined);
    assert.equal(run("check", "HEAD").status, 0);
    assert.equal(run("render", "HEAD").stdout, latest);
    assert.equal(run("check", "missing-base").status, 1);
    commit();
    assert.equal(run("render", "HEAD").stdout, latest);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires new notes, including on the first shipment and multiple shipments per day", () => {
  assert.deepEqual(requireNewReleaseNotes(latest, null), [latest.trim()]);
  assert.deepEqual(requireNewReleaseNotes(combined, old), [latest.trim()]);
  const next = latest.replace("New change", "Another change");
  assert.deepEqual(requireNewReleaseNotes(`${next}\n${combined}`, old), [
    next.trim(),
    latest.trim(),
  ]);
  assert.deepEqual(requireNewReleaseNotes(combined.replace(/\n/g, "\r\n"), old), [latest.trim()]);
  assert.throws(() => requireNewReleaseNotes(old, old), /prepend a dated summary/);
});

test("preserves history and rejects rewritten, removed, duplicated or reordered entries", () => {
  assert.throws(
    () => requireNewReleaseNotes(combined.replace("Existing", "Changed"), old),
    /preserve/,
  );
  assert.throws(() => requireNewReleaseNotes(latest, combined), /preserve/);
  assert.throws(() => requireNewReleaseNotes(`${old}\n${latest}`, old), /newest entries first/);
  assert.throws(() => requireNewReleaseNotes(`${latest}\n${latest}`, null), /unique dated title/);
  assert.deepEqual(addedReleaseNotes(combined, combined), []);
});

test("rejects missing summaries and invalid dates instead of counting a file touch as release notes", () => {
  for (const invalid of [
    "",
    "# Notes\n- Changed.",
    "## 2026-11-05 — Empty\n",
    latest.replace("11-05", "02-30"),
  ]) {
    assert.throws(() => requireNewReleaseNotes(invalid, null), /each entry needs|invalid date/);
  }
});
