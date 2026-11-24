const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { githubRepository, main, waitForWindowsCheck } = require("./windows-check.cjs");

// A hook exports GIT_DIR and GIT_INDEX_FILE. Git for Windows opens /dev/null, not os.devNull (\\.\nul).
for (const name of Object.keys(process.env)) if (/^GIT_/i.test(name)) delete process.env[name];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

const COMMIT = "a".repeat(40);
const RUN_URL = "https://github.com/example/app/actions/runs/7";
const WORKFLOW_URL = "https://github.com/example/app/actions/workflows/windows-check-fork.yml";
const MINUTE = 60 * 1000;
const WALL_START = Date.UTC(2026, 10, 20, 12);
const OUT_OF_REQUESTS = "GitHub allows this address no more requests before the time limit.";

/**
 * GitHub's answer when it allows this address no more requests until `resetInMs` after it answers: `body` when this
 * request was the last one allowed, a 403 when none was.
 */
const rateLimited = (resetInMs, body) => (now) => {
  const headers = {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": String(Math.ceil((now + resetInMs) / 1000)),
  };
  return body ? Response.json(body, { headers }) : new Response("{}", { status: 403, headers });
};

/**
 * GitHub's answers, each list in order with its last repeated: `runs` for the listing of `commit`'s push runs, `run`
 * for the run by its id. A run is an object, an HTTP status a number, a network failure an Error, and a function gets
 * the wall clock and returns the Response. Only `sleep` moves the clocks; `requests` lists the minute of each request.
 */
function github({ runs = [], run = [], jobs = [], annotations = {}, commit = COMMIT }) {
  let elapsed = 0;
  const requests = [];
  const next = (answers) => (answers.length > 1 ? answers.shift() : answers[0]);
  const answer = (value, body) => {
    if (value instanceof Error) throw value;
    if (typeof value === "function") return value(WALL_START + elapsed);
    if (typeof value === "number") return new Response("{}", { status: value });
    return Response.json(body(value));
  };
  const fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    requests.push(elapsed / MINUTE);
    if (pathname === "/repos/example/app/actions/workflows/windows-check-fork.yml/runs") {
      const ofCommit =
        searchParams.get("head_sha") === commit && searchParams.get("event") === "push";
      return answer(next(runs), (found) => ({
        workflow_runs: found && ofCommit ? [{ id: 7, html_url: RUN_URL, ...found }] : [],
      }));
    }
    if (pathname === "/repos/example/app/actions/runs/7") {
      return answer(next(run), (found) => ({ id: 7, html_url: RUN_URL, ...found }));
    }
    if (pathname === "/repos/example/app/actions/runs/7/jobs") {
      return answer(jobs, (found) => ({ jobs: found }));
    }
    const job = /\/check-runs\/(\d+)\/annotations$/.exec(pathname);
    if (job) return answer(annotations[job[1]] ?? [], (found) => found);
    return new Response("{}", { status: 404 });
  };
  return {
    repository: "example/app",
    commit,
    fetch,
    clock: () => elapsed,
    now: () => WALL_START + elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    elapsed: () => elapsed,
    requests,
  };
}

const failedRun = {
  runs: [{ status: "queued" }],
  run: [{ status: "in_progress" }, { status: "completed", conclusion: "failure" }],
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
        path: "apps/server/src/Slow.test.ts",
        start_line: 12,
        message: null,
        title: "Test timed out in 5000ms",
      },
      {
        annotation_level: "failure",
        path: ".github",
        start_line: 1,
        message: "Process completed with exit code 1.",
      },
    ],
  },
};

test("a lander waits through a queued and running check and gets a failed run's failing steps and test lines", async () => {
  const result = await waitForWindowsCheck(github(structuredClone(failedRun)));

  assert.deepEqual(result, {
    status: "failed",
    url: RUN_URL,
    conclusion: "failure",
    failures: [
      'check:changed on Windows: step "Check the pushed commits" failed',
      "apps/web/src/Preview.browser.test.tsx:858 AssertionError: expected 2 to be 1",
      "apps/server/src/Slow.test.ts:12 Test timed out in 5000ms",
      "Process completed with exit code 1.",
    ],
  });
});

test("a failed run whose jobs or annotations GitHub does not answer reports what it could read", async () => {
  const failing = { status: "completed", conclusion: "failure" };
  const step = { name: "Check the pushed commits", conclusion: "failure" };
  for (const [answers, failures] of [
    [{ jobs: 500 }, ["GitHub answered 500 for the run's jobs."]],
    // A 403 that names no rate limit denies the request, so it is not asked again.
    [{ jobs: 403 }, ["GitHub answered 403 for the run's jobs."]],
    [
      {
        jobs: [{ id: 11, name: "Windows", conclusion: "failure", steps: [step] }],
        annotations: { 11: 500 },
      },
      [
        'Windows: step "Check the pushed commits" failed',
        "GitHub answered 500 for the annotations of Windows.",
      ],
    ],
  ]) {
    const result = await waitForWindowsCheck(github({ runs: [failing], ...answers }));
    assert.deepEqual(result.failures, failures);
  }
});

test("a run that passed, one GitHub skips and a workflow GitHub does not show end the wait at once", async () => {
  for (const [runs, status, url] of [
    [[{ status: "completed", conclusion: "success" }], "passed", RUN_URL],
    [[{ status: "completed", conclusion: "skipped" }], "none", RUN_URL],
    // A private repository answers 404 without a token, so its check is unread, not missing.
    [[404], "unreadable", WORKFLOW_URL],
  ]) {
    const fake = github({ runs });
    const result = await waitForWindowsCheck(fake);
    assert.deepEqual([result.status, result.url, fake.elapsed()], [status, url, 0]);
  }
});

test("no run is reported as not started only when GitHub answered, and a run that never ends as unfinished", async () => {
  const missing = github({ runs: [null] });
  assert.deepEqual(await waitForWindowsCheck(missing), {
    status: "not-started",
    url: WORKFLOW_URL,
    reason: `No windows-check-fork.yml run started for ${COMMIT}.`,
  });
  assert.equal(missing.elapsed(), 15 * MINUTE);

  // An address over GitHub's hourly limit, then an outage: neither means the run is missing.
  const unreachable = github({ runs: [403, new Error("ECONNRESET")] });
  const result = await waitForWindowsCheck(unreachable);
  assert.deepEqual([result.status, result.url], ["unfinished", WORKFLOW_URL]);
  assert.match(result.reason, /ECONNRESET/);
  assert.equal(unreachable.elapsed(), 400 * MINUTE);

  const running = github({ runs: [{ status: "in_progress" }], run: [{ status: "in_progress" }] });
  assert.deepEqual(await waitForWindowsCheck(running), {
    status: "unfinished",
    url: RUN_URL,
    reason: "It is still running.",
  });

  // A run GitHub listed and then stopped showing is not a workflow GitHub does not show.
  const vanished = github({ runs: [{ status: "in_progress" }], run: [404] });
  assert.deepEqual(await waitForWindowsCheck(vanished), {
    status: "unfinished",
    url: RUN_URL,
    reason: "GitHub answered 404.",
  });
});

test("an address out of requests asks again only after GitHub's reset, and not once it falls past the time limit", async () => {
  const limited = github({ runs: [rateLimited(120 * MINUTE)] });

  const result = await waitForWindowsCheck(limited);

  assert.deepEqual(limited.requests, [0, 120, 240, 360]);
  assert.deepEqual(result, { status: "unfinished", url: WORKFLOW_URL, reason: OUT_OF_REQUESTS });

  // A wait that ends past the time limit, as on a machine that slept, sends nothing after it.
  const slept = github({ runs: [rateLimited(400 * MINUTE)] });
  const late = await waitForWindowsCheck({
    ...slept,
    sleep: (ms) => slept.sleep(ms + 10 * MINUTE),
  });
  assert.deepEqual(slept.requests, [0]);
  assert.deepEqual(late, { status: "unfinished", url: WORKFLOW_URL, reason: OUT_OF_REQUESTS });
});

test("a failed run's failures are read only after GitHub's reset, and again when GitHub refuses that request", async () => {
  const failed = {
    workflow_runs: [{ id: 7, html_url: RUN_URL, status: "completed", conclusion: "failure" }],
  };
  const jobs = [{ id: 11, name: "Windows", conclusion: "failure", steps: [] }];
  const failing = { status: "completed", conclusion: "failure" };
  const step = { name: "Check the pushed commits", conclusion: "failure" };
  const stepFailed = ['Windows: step "Check the pushed commits" failed'];
  const outOfRequests = [`${OUT_OF_REQUESTS} (the run's jobs)`];
  // Another lander on this address used the last request between the run and its jobs.
  const refusedOnce = (
    status,
    headers,
    body = { jobs: [{ ...jobs[0], steps: [step] }] },
    refusal = "{}",
  ) => {
    let refused = false;
    return (now) => {
      if (refused) return Response.json(body);
      refused = true;
      return new Response(refusal, { status, headers: headers(now) });
    };
  };
  for (const [runs, jobAnswers, requests, failures, annotations] of [
    [rateLimited(30 * MINUTE, failed), jobs, [0, 30, 30], []],
    [rateLimited(500 * MINUTE, failed), jobs, [0], outOfRequests],
    [failing, refusedOnce(403, () => ({ "retry-after": "60" })), [0, 0, 1, 1], stepFailed],
    // Both limits refused it, so it waits for the later one.
    [
      failing,
      refusedOnce(403, (now) => ({
        "retry-after": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(now / 1000 + 30 * 60),
      })),
      [0, 0, 30, 30],
      stepFailed,
    ],
    // A secondary rate limit may say so only in its message.
    [
      failing,
      refusedOnce(
        403,
        () => ({}),
        undefined,
        JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
      ),
      [0, 0, 1, 1],
      stepFailed,
    ],
    // A refusal that names no time to wait, or a reset already past on this clock, waits a minute.
    [failing, refusedOnce(429, () => ({ "retry-after": "0" })), [0, 0, 1, 1], stepFailed],
    [
      failing,
      refusedOnce(403, (now) => ({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(now / 1000 - 60),
      })),
      [0, 0, 1, 1],
      stepFailed,
    ],
    // Each refusal in a row doubles the wait, until the next one falls past the time limit.
    [
      failing,
      () => new Response("{}", { status: 429 }),
      [0, 0, 1, 3, 7, 15, 31, 63, 127, 255],
      outOfRequests,
    ],
    // An answer ends the row: the next refusal waits a minute again.
    [
      failing,
      refusedOnce(429, () => ({})),
      [0, 0, 1, 1, 2],
      stepFailed,
      { 11: refusedOnce(429, () => ({}), []) },
    ],
  ]) {
    const fake = github({ runs: [runs], jobs: jobAnswers, annotations });
    const result = await waitForWindowsCheck(fake);
    assert.deepEqual(
      [result.status, result.failures, fake.requests],
      ["failed", failures, requests],
    );
  }
});

test("the command checks the run of the full commit on origin's GitHub push URL and exits 3 when it did not pass or could not check", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-check-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "before the workflow");
  const before = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github/workflows/windows-check-fork.yml"), "on: push\n");
  git("add", ".");
  git("commit", "-q", "-m", "landed");
  const commit = git("rev-parse", "HEAD");
  // Fetches come from a mirror; a push goes to the mirror and to GitHub, whose name it spells in two cases.
  git("remote", "add", "origin", "https://git.cafe/example/app.git");
  git("remote", "set-url", "--add", "--push", "origin", "https://git.cafe/example/app.git");
  git("remote", "set-url", "--add", "--push", "origin", "git@github.com:example/app.git");
  git("remote", "set-url", "--add", "--push", "origin", "https://github.com/Example/App");
  // A lander may run it from any folder of its checkout.
  const cwd = path.join(root, ".github");
  let reason;
  const check = async (target, answers) => {
    const { fetch, sleep, clock, now } = github({ ...answers, commit });
    const lines = [];
    const options = { cwd, log: (line) => lines.push(line), fetch, sleep, clock, now };
    const code = await main([target], options);
    const [{ commit: checked, status, url, ...rest }] = lines.map((line) => JSON.parse(line));
    reason = rest.reason;
    return { code, commit: checked, status, url };
  };
  const unreadable = (checked) => ({ code: 3, commit: checked, status: "unreadable", url: null });

  assert.deepEqual(await check(commit.slice(0, 12), structuredClone(failedRun)), {
    code: 3,
    commit,
    status: "failed",
    url: RUN_URL,
  });
  assert.deepEqual(
    await check(commit, { runs: [{ status: "completed", conclusion: "success" }] }),
    {
      code: 0,
      commit,
      status: "passed",
      url: RUN_URL,
    },
  );
  // A commit from before the workflow has no Windows check, so GitHub is not asked.
  assert.deepEqual(await check(before, { runs: [new Error("asked GitHub")] }), {
    code: 0,
    commit: before,
    status: "none",
    url: null,
  });
  // GitHub runs the pushed commit, not the one a replace ref shows in this checkout.
  git("replace", commit, before);
  assert.equal((await check(commit, structuredClone(failedRun))).status, "failed");
  git("replace", "-d", commit);

  // A check that cannot run reports why on the result line its callers read.
  assert.deepEqual(await check("no-such-commit", {}), unreadable("no-such-commit"));
  assert.equal(reason, "unknown commit no-such-commit");
  git("remote", "set-url", "--add", "--push", "origin", "https://github.com/example/fork.git");
  assert.deepEqual(await check(commit, structuredClone(failedRun)), unreadable(commit));
  assert.match(reason, /several GitHub repositories \(example\/app, example\/fork\)/);

  // A commit whose tree git cannot read is unreadable, not a commit without the workflow.
  const tree = git("rev-parse", `${commit}^{tree}`);
  const object = path.join(root, ".git/objects", tree.slice(0, 2), tree.slice(2));
  fs.chmodSync(object, 0o666);
  fs.rmSync(object);
  assert.deepEqual(await check(commit, { runs: [new Error("asked GitHub")] }), unreadable(commit));
  assert.match(reason, /cannot read/);
});

test("only GitHub remotes name a repository, with or without credentials, a port or .git", () => {
  for (const [url, repository] of [
    ["https://github.com/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["https://x-access-token:secret@github.com/GigaZoro/CodeShip", "GigaZoro/CodeShip"],
    ["https://GitHub.com/GigaZoro/CodeShip/", "GigaZoro/CodeShip"],
    ["git@github.com:GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["git@github.com:/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["github.com:GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["ssh://git@github.com/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["ssh://git@github.com:22/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["ssh://git@ssh.github.com:443/GigaZoro/CodeShip.git", "GigaZoro/CodeShip"],
    ["https://ssh.github.com/GigaZoro/CodeShip.git", null],
    ["https://github.com.example.invalid/GigaZoro/CodeShip.git", null],
    ["https://github.com/GigaZoro/CodeShip/tree/main", null],
    ["https://git.cafe/GigaZoro/CodeShip.git", null],
    ["C:/Users/fixture/origin.git", null],
  ]) {
    assert.equal(githubRepository(url), repository, url);
  }
});
