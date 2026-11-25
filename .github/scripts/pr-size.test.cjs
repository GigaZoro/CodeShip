const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");

const { GIT_OUTPUT_MAX_BYTES } = require("./git-history.cjs");

const repoRoot = join(__dirname, "../..");
const workflow = readFileSync(join(__dirname, "../workflows/pr-size.yml"), "utf8");
const step = workflow.match(
  /- name: Sync PR size label\n[\s\S]*?          script: \|\n((?:            .*\n|\n)+)/,
);
assert.ok(step, "Could not find the PR size label step");
const script = step[1].replace(/^ {12}/gm, "");
const AsyncFunction = (async () => {}).constructor;

const git = (cwd, args, input) =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
  }).trim();

test("sizes a pull request whose numstat passes Node's 1 MiB default", async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-pr-size-test-"));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  try {
    // The step runs git with this process's environment: the fixture needs an identity on a runner without one, and
    // none of the machine's config or attributes. A hook exports GIT_DIR.
    for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      XDG_CONFIG_HOME: join(root, "config"),
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      PR_SIZE_LABELS_JSON: "[]",
    });

    const origin = join(root, "origin");
    git(root, ["init", "-q", origin]);
    git(origin, ["commit", "-q", "--allow-empty", "-m", "base"]);
    const base = git(origin, ["rev-parse", "HEAD"]);
    // One line per file, which takes numstat past 1 MiB.
    const blob = git(origin, ["hash-object", "-w", "--stdin"], "added\n");
    const files = Array.from(
      { length: 8000 },
      (_, index) => `added-${String(index).padStart(4, "0")}-${"x".repeat(140)}.txt`,
    );
    git(
      origin,
      ["update-index", "--add", "--index-info"],
      files.map((file) => `100644 ${blob}\t${file}\n`).join(""),
    );
    const tree = git(origin, ["write-tree"]);
    const head = git(origin, ["commit-tree", tree, "-p", base, "-m", "head"]);
    git(origin, ["update-ref", "refs/pull/7/head", head]);
    const workspace = join(root, "workspace");
    git(root, ["clone", "-q", origin, workspace]);

    const added = [];
    const info = [];
    const run = new AsyncFunction("require", "context", "github", "core", script);
    process.chdir(workspace);
    await run(
      // github-script resolves a relative require from the checkout, which is this repository in the workflow.
      (id) => require(id.startsWith("./") ? join(repoRoot, id) : id),
      {
        payload: { pull_request: { number: 7, base: { sha: base }, head: { sha: head } } },
        repo: { owner: "owner", repo: "repo" },
      },
      {
        rest: {
          issues: {
            listLabelsOnIssue: async () => ({ data: [] }),
            removeLabel: async () => assert.fail("removed a label from an unlabeled PR"),
            addLabels: async ({ labels }) => added.push(...labels),
          },
        },
      },
      { info: (message) => info.push(message), warning: (message) => assert.fail(message) },
    );

    assert.deepEqual(added, ["size:XXL"]);
    assert.deepEqual(info, [
      "PR #7: 8000 non-test lines, 0 test lines, 8000 effective lines -> size:XXL (all non-test changes)",
    ]);
  } finally {
    process.chdir(previousCwd);
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(previousEnv, name)) delete process.env[name];
    }
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});
