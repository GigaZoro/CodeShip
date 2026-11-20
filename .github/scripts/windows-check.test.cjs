const assert = require("node:assert/strict");
const { test } = require("node:test");

const { githubRepository, waitForWindowsCheck } = require("./windows-check.cjs");

const COMMIT = "a".repeat(40);
const RUN_URL = "https://github.com/example/app/actions/runs/7";
const MINUTE = 60 * 1000;

/** GitHub's answers by path, the run listing's in order; a clock that only `sleep` moves. */
function github({ runs, jobs = [], annotations = {} }) {
  let now = 0;
  const pending = [...runs];
  const fetch = async (url) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith("/actions/workflows/windows-check-fork.yml/runs")) {
      const next = pending.length > 1 ? pending.shift() : pending[0];
      if (next instanceof Error) throw next;
      if (typeof next === "number") return new Response("{}", { status: next });
      return Response.json({ workflow_runs: next ? [{ id: 7, html_url: RUN_URL, ...next }] : [] });
    }
    if (pathname === "/repos/example/app/actions/runs/7/jobs") return Response.json({ jobs });
    const job = /\/check-runs\/(\d+)\/annotations$/.exec(pathname);
    if (job) return Response.json(annotations[job[1]] ?? []);
    return new Response("{}", { status: 404 });
  };
  return {
    repository: "example/app",
    commit: COMMIT,
    fetch,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    elapsed: () => now,
  };
}

test("a lander waits through a queued and running check and gets a failed run's failing steps and test lines", async () => {
  const fake = github({
    runs: [
      { status: "queued" },
      { status: "in_progress" },
      { status: "completed", conclusion: "failure" },
    ],
    jobs: [
      {
        id: 11,
        name: "check:changed on Windows",
        conclusion: "failure",
        steps: [
          { name: "Install", conclusion: "success" },
          { name: "Check the pushed commits", conclusion: "failure" },
        ],
      },
    ],
    annotations: {
      11: [
        {
          annotation_level: "failure",
          path: "apps/web/src/Preview.browser.test.tsx",
          start_line: 858,
          message: "AssertionError: expected 2 to be 1\n    at stack",
        },
        { annotation_level: "warning", path: "README.md", start_line: 1, message: "noise" },
        {
          annotation_level: "failure",
          path: ".github",
          start_line: 1,
          message: "Process completed with exit code 1.",
        },
      ],
    },
  });

  const result = await waitForWindowsCheck(fake);

  assert.deepEqual(result, {
    status: "failed",
    url: RUN_URL,
    conclusion: "failure",
    failures: [
      'check:changed on Windows: step "Check the pushed commits" failed',
      "apps/web/src/Preview.browser.test.tsx:858 AssertionError: expected 2 to be 1",
      "Process completed with exit code 1.",
    ],
  });
});

test("a run that passed, one GitHub skips and a repository without the workflow end the wait at once", async () => {
  for (const [runs, status] of [
    [[{ status: "completed", conclusion: "success" }], "passed"],
    [[{ status: "completed", conclusion: "skipped" }], "none"],
    [[404], "none"],
  ]) {
    const fake = github({ runs });
    const result = await waitForWindowsCheck(fake);
    assert.equal(result.status, status);
    assert.equal(fake.elapsed(), 0);
  }
});

test("no run is reported as not started only when GitHub answered, and a run that never ends as unfinished", async () => {
  const missing = github({ runs: [null] });
  assert.equal((await waitForWindowsCheck(missing)).status, "not-started");
  assert.ok(missing.elapsed() >= 15 * MINUTE && missing.elapsed() < 20 * MINUTE);

  // An address over GitHub's hourly limit, then an outage: neither means the run is missing.
  const unreachable = github({ runs: [403, new Error("ECONNRESET")] });
  const result = await waitForWindowsCheck(unreachable);
  assert.equal(result.status, "unfinished");
  assert.match(result.reason, /ECONNRESET/);
  assert.ok(unreachable.elapsed() >= 400 * MINUTE);

  const running = github({ runs: [{ status: "in_progress" }] });
  assert.deepEqual(await waitForWindowsCheck(running), {
    status: "unfinished",
    url: RUN_URL,
    reason: "It is still running.",
  });
});

test("only GitHub remotes name a repository, with or without credentials or .git", () => {
  for (const [url, repository] of [
    ["https://github.com/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["https://x-access-token:secret@github.com/GigaZoro/CodeShip", "GigaZoro/CodeShip"],
    ["git@github.com:GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["ssh://git@github.com/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["https://git.cafe/GigaZoro/CodeShip.git", null],
    ["C:/Users/fixture/origin.git", null],
  ]) {
    assert.equal(githubRepository(url), repository, url);
  }
});
