const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MERGE_DRIVER_CONFIG,
  addedReleaseNotes,
  mergeReleaseNotes,
  requireNewReleaseNotes,
} = require("./release-notes.cjs");

const old = "## 2026-11-04 — Earlier change\n\n- Existing behavior.\n";
const latest = "## 2026-11-05 — New change\n\n- New behavior.\n";
const combined = `${latest}\n${old}`;
const entry = (date, title) => `## ${date} — ${title}\n\n- ${title}.`;
const notes = (...entries) => `${entries.join("\n\n")}\n`;
const shipped = entry("2026-11-18", "Shipped");
const sameDay = entry("2026-11-18", "Main same day");
const newer = entry("2026-11-19", "Main newer");
const mine = entry("2026-11-18", "Mine");

test("checks actual git history and fails closed when the base cannot be read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-"));
  try {
    fs.mkdirSync(path.join(root, ".github/scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.copyFileSync(__dirname + "/release-notes.cjs", root + "/.github/scripts/release-notes.cjs");
    fs.copyFileSync(__dirname + "/git-history.cjs", root + "/.github/scripts/git-history.cjs");
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
    fs.writeFileSync(path.join(root, "docs/release-notes.md"), old);
    assert.equal(run("check", "HEAD~1", "HEAD").status, 0);
    assert.equal(run("check", "HEAD", "HEAD").status, 1);
    // Notes past execFileSync's 1 MiB default, read from both commits.
    const history = notes(
      ...Array.from({ length: 3000 }, (_, index) =>
        entry("2026-11-04", `Earlier change ${index} ${"x".repeat(200)}`),
      ),
    );
    fs.writeFileSync(path.join(root, "docs/release-notes.md"), history);
    commit();
    fs.writeFileSync(path.join(root, "docs/release-notes.md"), `${latest}\n${history}`);
    commit();
    assert.equal(run("check", "HEAD~1", "HEAD").status, 0);
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
  // A base a rebase left out of date order can be repaired, and an unreleased entry moved down still counts.
  assert.deepEqual(requireNewReleaseNotes(`${next}\n${combined}`, `${old}\n${latest}`), [
    next.trim(),
  ]);
  const sameDay = old.replace("Earlier change", "Same-day change");
  assert.deepEqual(addedReleaseNotes(`${latest}\n${sameDay}\n${old}`, old), [
    latest.trim(),
    sameDay.trim(),
  ]);
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

test("a merge places one side's new entries among the other side's by date", () => {
  const base = notes(shipped);
  assert.equal(
    mergeReleaseNotes(base, notes(newer, sameDay, shipped), notes(mine, shipped)),
    notes(newer, mine, sameDay, shipped),
  );
  const newest = entry("2026-11-20", "Newest");
  assert.equal(
    mergeReleaseNotes(base, notes(newer, shipped), notes(newest, mine, shipped)),
    notes(newest, newer, mine, shipped),
  );
  // The same shipment reached both sides, as after a cherry-pick, and keeps its place above the incoming one's.
  assert.equal(
    mergeReleaseNotes(base, notes(mine, shipped), notes(mine, shipped)),
    notes(mine, shipped),
  );
  assert.equal(
    mergeReleaseNotes(base, notes(mine, shipped), notes(mine, sameDay, shipped)),
    notes(mine, sameDay, shipped),
  );
  assert.equal(mergeReleaseNotes("", notes(newer), notes(mine)), notes(newer, mine));
  // A later commit of a shipment rewords, retitles, redates, edits or drops its entry while main gained entries beside
  // it, and stays above main's of the same date.
  const added = entry("2026-11-18", "Added");
  const retitled = entry("2026-11-18", "Retitled");
  const sameDayEdited = sameDay.replace("- Main same day.", "- Edited.");
  assert.equal(
    mergeReleaseNotes(
      notes(mine, shipped),
      notes(mine, sameDay, shipped),
      notes(retitled, shipped),
    ),
    notes(retitled, sameDay, shipped),
  );
  const reworded = entry("2026-11-19", "Mine reworded");
  assert.equal(
    mergeReleaseNotes(notes(mine, shipped), notes(newer, mine, shipped), notes(reworded, shipped)),
    notes(reworded, newer, shipped),
  );
  const edited = shipped.replace("- Shipped.", "- Edited.");
  assert.equal(
    mergeReleaseNotes(notes(mine, shipped), notes(newer, mine, shipped), notes(mine, edited)),
    notes(newer, mine, edited),
  );
  const mineEdited = mine.replace("- Mine.", "- Mine edited.");
  assert.equal(
    mergeReleaseNotes(
      notes(mine, shipped),
      notes(sameDay, mine, shipped),
      notes(mineEdited, shipped),
    ),
    notes(sameDay, mineEdited, shipped),
  );
  assert.equal(
    mergeReleaseNotes(notes(mine, shipped), notes(newer, mine, shipped), notes(shipped)),
    notes(newer, shipped),
  );
  // One side moved entries the other side's new one sits between, possibly beside one entry both added, or both added
  // one entry in different places.
  const moved = notes(sameDay, shipped);
  assert.equal(
    mergeReleaseNotes(
      moved,
      notes(newer, mine, sameDay, shipped),
      notes(newest, mine, shipped, sameDay),
    ),
    notes(newest, newer, mine, shipped, sameDay),
  );
  assert.equal(
    mergeReleaseNotes(
      moved,
      notes(newest, mine, shipped, sameDay),
      notes(newer, mine, sameDay, shipped),
    ),
    notes(newest, newer, mine, shipped, sameDay),
  );
  assert.equal(
    mergeReleaseNotes(moved, notes(newer, sameDay, shipped), notes(mine, shipped, sameDay)),
    notes(newer, mine, shipped, sameDay),
  );
  assert.equal(
    mergeReleaseNotes(moved, notes(shipped, sameDay), notes(newer, sameDay, shipped)),
    notes(newer, shipped, sameDay),
  );
  assert.equal(
    mergeReleaseNotes(moved, notes(newer, sameDay, shipped), notes(shipped, sameDayEdited)),
    notes(newer, shipped, sameDayEdited),
  );
  assert.equal(
    mergeReleaseNotes(moved, notes(added, sameDay, shipped), notes(sameDay, added, shipped)),
    notes(added, sameDay, shipped),
  );
  // One side already holds a title under two dates and shares one of them with the other, so nothing is published twice.
  const menu = entry("2026-11-20", "Menu");
  const menuBefore = entry("2026-11-19", "Menu");
  assert.equal(
    mergeReleaseNotes(base, notes(menu, menuBefore, shipped), notes(newest, menuBefore, shipped)),
    notes(newest, menu, menuBefore, shipped),
  );
  assert.equal(
    mergeReleaseNotes(base, notes(newest, menuBefore, shipped), notes(menu, menuBefore, shipped)),
    notes(menu, newest, menuBefore, shipped),
  );
  // Changes to the base's entries on both sides, a new entry the entries around it leave no place for, one heading
  // added with different text, one entry added on both sides while one of them rewrote or dropped a base entry (a
  // retitle, or an edit that reuses a retitled entry's heading, can reproduce another shipment's entry), or a new entry
  // whose title or text only the other side added or changed under another heading go to git's text merge.
  for (const [ours, theirs] of [
    [notes(newer, sameDay, shipped.replace("- Shipped.", "- Other.")), notes(sameDay, edited)],
    [notes(newer, sameDayEdited, shipped), notes(sameDay, edited)],
    [notes(newer, sameDayEdited), notes(shipped)],
    [notes(newer, sameDay), notes(sameDay, edited)],
    [notes(entry("2026-11-18", "Ours retitled"), shipped), notes(retitled, shipped)],
    [notes(retitled, shipped), notes(sameDay, retitled)],
    [notes(shipped, sameDay), notes(retitled, shipped)],
    [notes(shipped, sameDay), notes(sameDay, added, shipped)],
    [notes(menu, sameDay, shipped), notes(menuBefore, shipped)],
    [notes(menuBefore, shipped), notes(menu, sameDay, shipped)],
    [notes(menu, sameDay, shipped), notes(retitled.replace("- Retitled.", "- Menu."), shipped)],
    [notes(menu, sameDay, shipped), notes(menuBefore.replace("- Menu.", "- Other."), shipped)],
    [
      notes(newer, sameDay, shipped),
      notes(newer.replace("- Main newer.", "- Other."), sameDay, shipped),
    ],
    [notes(newer, added, sameDay, shipped), notes(added, shipped)],
    [notes(added, shipped), notes(newer, added, sameDay, shipped)],
    [notes(sameDay, added, shipped), notes(sameDayEdited, added, shipped)],
    [notes(sameDayEdited, added, shipped), notes(sameDay, added, shipped)],
  ]) {
    assert.equal(mergeReleaseNotes(notes(sameDay, shipped), ours, theirs), null);
  }
  // As does a merge that would leave no entry.
  assert.equal(mergeReleaseNotes(notes(shipped), notes(shipped), ""), null);
});

test("git rebases a shipment over another one's notes through the configured merge driver", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-merge-")));
  try {
    fs.mkdirSync(path.join(root, ".github/scripts"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"));
    fs.copyFileSync(__dirname + "/release-notes.cjs", root + "/.github/scripts/release-notes.cjs");
    fs.copyFileSync(__dirname + "/git-history.cjs", root + "/.github/scripts/git-history.cjs");
    fs.copyFileSync(__dirname + "/../../.gitattributes", root + "/.gitattributes");
    const notesFile = path.join(root, "docs/release-notes.md");
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=",
          ...args,
        ],
        { cwd: root, stdio: "pipe" },
      );
    const commit = (text) => {
      fs.writeFileSync(notesFile, text);
      git("add", ".");
      git("commit", "-q", "-m", "fixture");
    };
    git("init", "-q", "-b", "main");
    execFileSync(process.execPath, [".github/scripts/release-notes.cjs", "configure"], {
      cwd: root,
    });
    commit(notes(shipped));
    git("switch", "-q", "-c", "shipment");
    commit(notes(mine, shipped));
    git("switch", "-q", "main");
    commit(notes(newer, sameDay, shipped));
    git("switch", "-q", "shipment");
    git("rebase", "-q", "main");
    assert.equal(fs.readFileSync(notesFile, "utf8"), notes(newer, mine, sameDay, shipped));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the merge driver leaves notes that are not UTF-8 to git's byte-for-byte text merge", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-bytes-")));
  try {
    const older = entry("2026-11-10", "Older");
    // Main's bullet ends in a Latin-1 é, a byte that is not UTF-8.
    const edited = (above) =>
      Buffer.concat([
        Buffer.from(`${above}${older.slice(0, -1)} caf`),
        Buffer.from([0xe9]),
        Buffer.from(".\n"),
      ]);
    const [base, ours, theirs] = ["base", "ours", "theirs"].map((name) => path.join(root, name));
    fs.writeFileSync(base, notes(shipped, older));
    fs.writeFileSync(ours, notes(mine, shipped, older));
    fs.writeFileSync(theirs, edited(`${shipped}\n\n`));
    const merge = spawnSync(
      process.execPath,
      [path.join(__dirname, "release-notes.cjs"), "merge", base, ours, theirs],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(merge.status, 0, merge.stderr);
    assert.deepEqual(fs.readFileSync(ours), edited(`${mine}\n\n${shipped}\n\n`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const withScript = (dir) => {
  fs.mkdirSync(path.join(dir, ".github/scripts"), { recursive: true });
  fs.copyFileSync(__dirname + "/release-notes.cjs", dir + "/.github/scripts/release-notes.cjs");
  fs.copyFileSync(__dirname + "/git-history.cjs", dir + "/.github/scripts/git-history.cjs");
  fs.copyFileSync(__dirname + "/../../.gitattributes", dir + "/.gitattributes");
  return dir;
};
const configureIn = (dir, env = {}) =>
  spawnSync(process.execPath, [".github/scripts/release-notes.cjs", "configure"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
const localDrivers = (dir) =>
  spawnSync("git", ["config", "--local", "--get-all", "merge.release-notes.driver"], {
    cwd: dir,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean);

test("configure sets the driver in its own repository only", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-configure-")));
  try {
    const outer = path.join(root, "outer");
    execFileSync("git", ["init", "-q", "-b", "main", outer]);
    // A source archive unpacked inside another checkout, set up by hand and from that checkout's hook.
    const archive = withScript(path.join(outer, "archive"));
    for (const env of [
      {},
      { GIT_DIR: path.join(outer, ".git") },
      { Git_Dir: path.join(outer, ".git") },
    ]) {
      assert.equal(configureIn(archive, env).status, 0);
    }
    assert.deepEqual(localDrivers(outer), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configure replaces stale values, and warns without failing the install when it cannot set one", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-notes-configure-")));
  try {
    // A path that only a byte-exact comparison handles. Windows drops a trailing space, but keeps a no-break space.
    const own = withScript(path.join(root, "checkout "));
    const git = (...args) => execFileSync("git", args, { cwd: own, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "--add", "merge.release-notes.driver", "stale");
    git("config", "--add", "merge.release-notes.driver", "stale");
    const lock = path.join(own, ".git/config.lock");
    fs.writeFileSync(lock, "");
    const locked = configureIn(own);
    assert.deepEqual([locked.status, /could not set/.test(locked.stderr)], [0, true]);
    fs.rmSync(lock);
    const [[key, value]] = MERGE_DRIVER_CONFIG;
    assert.equal(configureIn(own).status, 0);
    assert.deepEqual(localDrivers(own), [value]);
    // Once set, configure only reads, so another setup holding the lock does not matter.
    fs.writeFileSync(lock, "");
    const again = configureIn(own);
    assert.deepEqual([again.status, again.stderr], [0, ""]);
    fs.rmSync(lock);
    // A right value in this worktree's own config does not hide a wrong one its siblings use.
    git("config", "extensions.worktreeConfig", "true");
    git("config", "--worktree", key, value);
    git("config", "--local", key, "false");
    assert.deepEqual([configureIn(own).stderr, localDrivers(own)], ["", [value]]);
    git("config", "--worktree", key, "true");
    const overridden = configureIn(own);
    assert.deepEqual(
      [overridden.status, /with `true` from .*config\.worktree/.test(overridden.stderr)],
      [0, true],
    );
    git("config", "--worktree", key, value);
    fs.mkdirSync(path.join(own, ".git/info"), { recursive: true });
    fs.writeFileSync(path.join(own, ".git/info/attributes"), "docs/release-notes.md merge=union\n");
    const union = configureIn(own);
    assert.deepEqual([union.status, /merge attribute `union`/.test(union.stderr)], [0, true]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
