const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  TURN_MAX_MS,
  testing: { withPrivateCheckout, KEPT_CHECKOUTS },
} = require("./landing-turn.cjs");
const { setup } = require("./landing-turn.testkit.cjs");

// oxlint-disable-next-line t3code/no-global-process-runtime -- a plain node test, with no Effect runtime
const POSIX_ONLY = { skip: process.platform === "win32" };

// Holds a checkout in another process until it is stopped, and prints the checkout's directory.
const HOLDER = `
const { withPrivateCheckout } = require(process.env.LANDING_TURN).testing;
withPrivateCheckout({ cwd: process.env.LANDER, commit: process.env.COMMIT }, (directory) => {
  console.log(directory);
  return new Promise(() => setInterval(() => {}, 60 * 60 * 1000));
});
`;

function fixture() {
  const { root, git, clone } = setup();
  const dir = clone("lander");
  const write = (file, text = "") => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  write(".gitignore", "node_modules\n*.tsbuildinfo\n");
  write("package.json", "{}\n");
  write("kept/package.json", "{}\n");
  write("gone/package.json", "{}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "packages");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "rm", "-q", "gone/package.json");
  git(dir, "commit", "-qm", "drop gone");
  const second = git(dir, "rev-parse", "HEAD");
  const listed = () => git(dir, "worktree", "list", "--porcelain");
  return { root, git, dir, first, second, listed };
}

function holdInChild(cwd, commit) {
  const child = spawn(process.execPath, ["-e", HOLDER], {
    env: {
      ...process.env,
      LANDING_TURN: require.resolve("./landing-turn.cjs"),
      LANDER: cwd,
      COMMIT: commit,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal })),
  );
  const directory = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.trim());
    });
    child.on("exit", () => reject(new Error(`the holder exited first: ${out}`)));
  });
  return { child, exited, directory };
}

/** Runs `run` while every kept checkout is held, and returns the kept directories. */
async function withKeptHeld(cwd, commit, run) {
  const held = [];
  const hold = (left) =>
    withPrivateCheckout({ cwd, commit }, async (directory) => {
      held.push(directory);
      if (left > 1) return hold(left - 1);
      return run(held);
    });
  await hold(KEPT_CHECKOUTS);
  return held;
}

test("a second check reuses the kept checkout's node_modules, and nothing else the first one left", async () => {
  const { root, git, dir, first, second } = fixture();
  try {
    const used = await withPrivateCheckout({ cwd: dir, commit: first }, (directory) => {
      for (const file of [
        "node_modules/.vite/task-cache/marker",
        "kept/node_modules/marker",
        "gone/node_modules/marker",
        "stray.txt",
        "build/out.js",
        "kept/app.tsbuildinfo",
      ]) {
        fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
        fs.writeFileSync(path.join(directory, file), "");
      }
      fs.writeFileSync(path.join(directory, "base.txt"), "edited\n");
      return directory;
    });

    await withPrivateCheckout({ cwd: dir, commit: second }, (directory) => {
      assert.equal(directory, used);
      assert.equal(git(directory, "rev-parse", "HEAD"), second);
      assert.equal(fs.readFileSync(path.join(directory, "base.txt"), "utf8"), "base\n");
      // The package the second commit removed takes its node_modules with it.
      assert.equal(fs.existsSync(path.join(directory, "gone")), false);
      assert.deepEqual(git(directory, "status", "--porcelain", "--ignored").split("\n").sort(), [
        "!! kept/node_modules/",
        "!! node_modules/",
      ]);
      assert.ok(fs.existsSync(path.join(directory, "node_modules/.vite/task-cache/marker")));
      assert.ok(fs.existsSync(path.join(directory, "kept/node_modules/marker")));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a check finding every kept checkout busy gets one of its own, removed after it", async () => {
  const { root, dir, second, listed } = fixture();
  try {
    let extra;
    const kept = await withKeptHeld(dir, second, () =>
      withPrivateCheckout({ cwd: dir, commit: second }, (directory) => {
        extra = directory;
      }),
    );

    assert.equal(new Set([...kept, extra]).size, KEPT_CHECKOUTS + 1);
    assert.equal(fs.existsSync(extra), false);
    assert.equal(listed().includes(extra), false);
    for (const directory of kept) {
      assert.ok(fs.existsSync(directory));
      assert.ok(listed().includes(directory));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a kept checkout whose holder was killed mid-check, or that was damaged by hand, is recovered", async () => {
  const { root, git, dir, first, second, listed } = fixture();
  try {
    const holder = holdInChild(dir, first);
    let used;
    try {
      used = await holder.directory;
      // The holder died in a checkout: the index on another commit, a file half-written, git's lock left.
      fs.mkdirSync(path.join(used, "node_modules"));
      fs.writeFileSync(path.join(used, "node_modules/marker"), "");
      git(used, "read-tree", second);
      fs.writeFileSync(path.join(used, "base.txt"), "half\n");
      const lock = git(used, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");
      fs.writeFileSync(lock, "");
    } finally {
      holder.child.kill("SIGKILL");
      await holder.exited;
    }

    const check = () =>
      withPrivateCheckout({ cwd: dir, commit: second }, (directory) => {
        assert.equal(directory, used);
        assert.equal(git(directory, "rev-parse", "HEAD"), second);
        assert.equal(git(directory, "status", "--porcelain"), "");
        return fs.existsSync(path.join(directory, "node_modules/marker"));
      });
    assert.equal(await check(), true);

    // Its worktree entry pruned while the directory stays.
    const admin = git(used, "rev-parse", "--path-format=absolute", "--git-dir");
    fs.rmSync(admin, { recursive: true });
    await check();

    // The directory deleted, with its entry left behind.
    fs.rmSync(used, { recursive: true });
    await check();
    assert.equal(listed().split(used).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a stopped landing removes the checkout of its own, and the next landing one its killed lander left",
  POSIX_ONLY,
  async () => {
    const { root, dir, second, listed } = fixture();
    try {
      let killed;
      await withKeptHeld(dir, second, async () => {
        const stopped = holdInChild(dir, second);
        let own;
        try {
          own = await stopped.directory;
          assert.ok(fs.existsSync(own));
        } finally {
          stopped.child.kill("SIGTERM");
        }
        assert.deepEqual(await stopped.exited, { code: null, signal: "SIGTERM" });
        assert.equal(fs.existsSync(own), false);
        assert.equal(listed().includes(own), false);

        const dead = holdInChild(dir, second);
        try {
          killed = await dead.directory;
        } finally {
          dead.child.kill("SIGKILL");
          await dead.exited;
        }
        assert.ok(fs.existsSync(killed));
      });

      await withPrivateCheckout({ cwd: dir, commit: second }, () => {});
      assert.equal(fs.existsSync(killed), false);
      assert.equal(listed().includes(killed), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a landing removes the temp-folder checkouts older landings left, once no turn can still use them", async () => {
  const { root, git, dir, second, listed } = fixture();
  const old = path.join(os.tmpdir(), `t3-landing-${randomUUID()}`);
  const recent = path.join(os.tmpdir(), `t3-landing-${randomUUID()}`);
  try {
    for (const directory of [old, recent]) git(dir, "worktree", "add", "-q", "--detach", directory);
    const now = Date.parse("2026-01-01T00:00:00Z");
    const oldAdded = new Date(now - TURN_MAX_MS - 60 * 1000);
    fs.utimesSync(path.join(old, ".git"), oldAdded, oldAdded);
    fs.utimesSync(path.join(recent, ".git"), new Date(now), new Date(now));

    await withPrivateCheckout({ cwd: dir, commit: second, now: () => now }, () => {});

    assert.equal(fs.existsSync(old), false);
    assert.equal(listed().includes(path.basename(old)), false);
    assert.ok(fs.existsSync(recent));
  } finally {
    for (const directory of [old, recent]) fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
