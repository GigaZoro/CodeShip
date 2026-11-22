const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { dispatchOutput, releaseMacosRun } = require("./release-macos-run.cjs");

const REPOSITORY = "GigaZoro/CodeShip";
const RUN_URL = (id) => `https://github.com/${REPOSITORY}/actions/runs/${id}`;

// The end of the real log of run 44919164430's Publish GitHub Release job (`actions/jobs/136892706420/logs`): the
// first line carries a byte order mark before its timestamp, and a line of git's output holds a tab.
function jobLog({
  printed = [RUN_URL(44919730318)],
  version = "2026.1121.10",
  command = [],
  after = [],
} = {}) {
  const lines = [
    "﻿2026-11-21T15:31:50.1Z Current runner version: '2.330.0'",
    "2026-11-21T15:31:53.9Z hint: \tgit branch -m <name>",
    "2026-11-21T15:32:34.5Z 🎉 Release ready at https://github.com/GigaZoro/CodeShip/releases/tag/v2026.1121.10",
    '2026-11-21T15:32:34.6Z ##[group]Run gh workflow run release-fork-macos.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \\',
    '2026-11-21T15:32:34.6Z ^[[36;1mgh workflow run release-fork-macos.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \\^[[0m',
    '2026-11-21T15:32:34.6Z ^[[36;1m  -f version="$VERSION" -f bundle_run="$GITHUB_RUN_ID"^[[0m',
    ...command.map((line) => `2026-11-21T15:32:34.6Z ${line}`),
    "2026-11-21T15:32:34.6Z shell: /usr/bin/bash -e {0}",
    "2026-11-21T15:32:34.6Z env:",
    "2026-11-21T15:32:34.6Z   GH_TOKEN: ***",
    `2026-11-21T15:32:34.6Z   VERSION: ${version}`,
    "2026-11-21T15:32:34.6Z ##[endgroup]",
    ...printed.map((line) => `2026-11-21T15:32:35.8Z ${line}`),
    "2026-11-21T15:32:35.9Z Post job cleanup.",
    "2026-11-21T15:32:35.9Z [command]/usr/bin/git version",
    ...after.map((line) => `2026-11-21T15:32:36.0Z ${line}`),
    "2026-11-21T15:32:36.0Z Cleaning up orphan processes",
  ];
  return `${lines.join("\n")}\n`;
}

/** What gh says of the macOS run the dispatch step printed. */
const MACOS_RUN = {
  workflowName: "Release (fork) macOS",
  event: "workflow_dispatch",
  displayTitle: "Release (fork) macOS v2026.1121.10",
  createdAt: "2026-11-21T15:32:35Z",
};

const dispatchStep = (overrides = {}) => ({
  name: "Build the macOS app for this release",
  status: "completed",
  conclusion: "success",
  number: 10,
  startedAt: "2026-11-21T15:32:34Z",
  completedAt: "2026-11-21T15:32:35Z",
  ...overrides,
});

/** The release run's Publish GitHub Release job in one attempt (`databaseId` names its log). */
const publishJob = ({ job = {}, step = {}, steps } = {}, databaseId) => ({
  name: "Publish GitHub Release",
  databaseId,
  conclusion: "success",
  steps: steps ?? [
    { name: "Publish release", status: "completed", conclusion: "success" },
    dispatchStep(step),
  ],
  ...job,
});

/**
 * A fake gh: the release run's latest attempt (`earlier` describes the attempts before it, each as `job`, `step`,
 * `steps`, `log` and `status`), each publish job's log (an Error fails that call) and the runs a log may print,
 * recording every call. A `retry` attempt starts right after the first read of the run's latest attempt, so gh's
 * second request of that read, for its jobs, already gets the retry's.
 */
function fixture({
  status = "completed",
  log = jobLog(),
  runs = {},
  earlier = [],
  retry,
  ...latest
} = {}) {
  const calls = [];
  const macos = { 44919730318: MACOS_RUN, ...runs };
  const attempts = [...earlier, { ...latest, status, log }].map((each, index) => ({
    status: each.status ?? "completed",
    log: each.log ?? jobLog(),
    publish: publishJob(each, 136892706420 - earlier.length + index),
  }));
  const describe = (attempt) => {
    const { status, publish } = attempts[attempt - 1];
    const jobs = [{ name: "Preflight", conclusion: "success", steps: [] }, publish];
    return { status, attempt, jobs };
  };
  let pendingRetry = retry && {
    status: "in_progress",
    log: jobLog(),
    publish: publishJob(retry, 136892706420 + 1),
  };
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "api") {
      const [, escapes, endpoint] = args;
      assert.equal(escapes, "--allow-escape-sequences");
      const id = Number(
        /^repos\/GigaZoro\/CodeShip\/actions\/jobs\/(\d+)\/logs$/.exec(endpoint)[1],
      );
      const { log } = attempts.find((each) => each.publish.databaseId === id);
      if (log instanceof Error) throw log;
      return log;
    }
    assert.deepEqual(args.slice(args.indexOf("-R"), args.indexOf("-R") + 2), ["-R", REPOSITORY]);
    const id = args[2];
    if (id === "44919164430") {
      const fields = args[args.indexOf("--json") + 1].split(",");
      if (args.includes("--attempt"))
        return JSON.stringify(describe(Number(args[args.indexOf("--attempt") + 1])));
      const { status, attempt } = describe(attempts.length);
      if (pendingRetry) attempts.push(pendingRetry);
      pendingRetry = undefined;
      const jobs = fields.includes("jobs") ? { jobs: describe(attempts.length).jobs } : {};
      return JSON.stringify({ status, attempt, ...jobs });
    }
    if (!macos[id]) throw new Error(`gh run view ${id} failed: HTTP 404`);
    return JSON.stringify(macos[id]);
  };
  return { calls, result: () => releaseMacosRun(REPOSITORY, "44919164430", gh) };
}

const release = `${RUN_URL(44919164430)} (attempt 1)`;

test("the macOS run is the one the dispatch step printed, checked against the release's version and the step's time", () => {
  const { calls, result } = fixture();
  assert.deepEqual(result(), {
    outcome: "dispatched",
    run: 44919730318,
    url: RUN_URL(44919730318),
    release,
  });
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [
      ["run", "view", "44919164430"],
      ["run", "view", "44919164430"],
      ["api", "--allow-escape-sequences", `repos/${REPOSITORY}/actions/jobs/136892706420/logs`],
      ["run", "view", "44919730318"],
    ],
  );
  assert.ok(calls[1].join(" ").includes("--attempt 1 --json"));
  // Neither run's address is asked of gh: both come from the repository and the run's id.
  assert.deepEqual(
    calls.map((args) => (args.includes("--json") ? args[args.indexOf("--json") + 1] : null)),
    ["status,attempt", "status,attempt,jobs", null, "workflowName,event,displayTitle,createdAt"],
  );
});

test("a url in gh's answer changes neither run's address", () => {
  const gh = (answer) => () => JSON.stringify(answer);
  assert.deepEqual(
    releaseMacosRun(REPOSITORY, "42", gh({ status: "in_progress", attempt: 2, url: "", jobs: [] })),
    {
      outcome: "pending",
      reason: "the release run is in_progress",
      release: `${RUN_URL(42)} (attempt 2)`,
    },
  );
  const { result } = fixture({ runs: { 44919730318: { ...MACOS_RUN, url: "" } } });
  assert.equal(result().url, RUN_URL(44919730318));
});

test("a CRLF log reads the same, and a URL in the step's command is not what it printed", () => {
  assert.equal(fixture({ log: jobLog().replaceAll("\n", "\r\n") }).result().outcome, "dispatched");
  assert.equal(
    fixture({ log: jobLog({ command: [RUN_URL(44919999999)] }) }).result().run,
    44919730318,
  );
});

test("a release run that has not finished is pending", () => {
  assert.deepEqual(fixture({ status: "in_progress" }).result(), {
    outcome: "pending",
    reason: "the release run is in_progress",
    release,
  });
});

test("the build is not started only when its job or step was skipped", () => {
  assert.deepEqual(fixture({ job: { conclusion: "skipped" } }).result(), {
    outcome: "not-started",
    reason: "its Publish GitHub Release job was skipped",
    release,
  });
  assert.deepEqual(fixture({ step: { conclusion: "skipped" } }).result(), {
    outcome: "not-started",
    reason: 'its "Build the macOS app for this release" step was skipped',
    release,
  });
});

test("a dispatch step that failed after printing its run still names that run", () => {
  assert.equal(fixture({ step: { conclusion: "failure" } }).result().outcome, "dispatched");
  assert.deepEqual(
    fixture({ step: { conclusion: "failure" }, log: jobLog({ printed: ["HTTP 500"] }) }).result(),
    {
      outcome: "unverified",
      reason: "the dispatch step printed 0 run URLs (the step ended failure)",
      release,
    },
  );
});

test("anything that leaves the run uncertain is unverified, never guessed", () => {
  const other = RUN_URL(44919999999);
  const cases = [
    [{ job: { name: "Publish" } }, "the release run has 0 Publish GitHub Release jobs"],
    [
      { steps: [] },
      'its Publish GitHub Release job has 0 "Build the macOS app for this release" steps',
    ],
    [
      { step: { status: "in_progress" } },
      'its "Build the macOS app for this release" step is in_progress',
    ],
    [{ log: "" }, "the job's log has 0 macOS dispatch steps"],
    [{ log: jobLog() + jobLog() }, "the job's log has 2 macOS dispatch steps"],
    [
      { log: jobLog().replace(/^.*##\[endgroup\]\n/m, "") },
      "the dispatch step's log has no end to its command",
    ],
    [
      { log: jobLog().replace(/^.*VERSION: .*\n/m, "") },
      "the dispatch step's log names 0 versions",
    ],
    [
      { log: jobLog({ printed: [RUN_URL(44919730318), other] }) },
      "the dispatch step printed 2 run URLs",
    ],
    [{ log: jobLog({ printed: [] }) }, "the dispatch step printed 0 run URLs"],
    // A run printed by a later step, another repository's run, or a URL inside a longer line is not the dispatch.
    [{ log: jobLog({ printed: [], after: [other] }) }, "the dispatch step printed 0 run URLs"],
    [
      {
        log: jobLog({ printed: ["https://github.com/pingdotgg/t3code/actions/runs/44919730318"] }),
      },
      "the dispatch step printed 0 run URLs",
    ],
    [
      { log: jobLog({ printed: [`see ${RUN_URL(44919730318)}`] }) },
      "the dispatch step printed 0 run URLs",
    ],
    [
      { log: jobLog({ printed: [`${RUN_URL(44919730318)}/attempts/2`] }) },
      "the dispatch step printed 0 run URLs",
    ],
    [
      {
        runs: {
          44919730318: { ...MACOS_RUN, workflowName: "Windows check (fork)", displayTitle: "x" },
        },
      },
      'run 44919730318 has workflowName "Windows check (fork)", not "Release (fork) macOS"',
    ],
    [
      { log: jobLog({ version: "2026.1121.9" }) },
      'run 44919730318 has displayTitle "Release (fork) macOS v2026.1121.10", not "Release (fork) macOS v2026.1121.9"',
    ],
    [
      {
        runs: {
          44919730318: { ...MACOS_RUN, event: "push" },
        },
      },
      'run 44919730318 has event "push", not "workflow_dispatch"',
    ],
    [
      { step: { completedAt: "2026-11-21T15:32:34Z" } },
      "run 44919730318 was created at 2026-11-21T15:32:35Z, outside the dispatch step (2026-11-21T15:32:34Z to 2026-11-21T15:32:34Z)",
    ],
    [
      { step: { startedAt: "2026-11-21T15:32:36Z", completedAt: "2026-11-21T15:32:40Z" } },
      "run 44919730318 was created at 2026-11-21T15:32:35Z, outside the dispatch step (2026-11-21T15:32:36Z to 2026-11-21T15:32:40Z)",
    ],
  ];
  for (const [options, reason] of cases)
    assert.deepEqual(fixture(options).result(), { outcome: "unverified", reason, release }, reason);
});

test("a retry's build is the newest attempt not known to have skipped it, with every attempt's outcome", () => {
  const skipped = { job: { conclusion: "skipped" } };
  // The first attempt dispatched and the retry reran another job alone, so its publish job did not run again.
  const first = fixture({ earlier: [{}], ...skipped });
  assert.deepEqual(first.result(), {
    outcome: "dispatched",
    run: 44919730318,
    url: RUN_URL(44919730318),
    release: `${RUN_URL(44919164430)} (attempt 1)`,
    attempts: [
      { attempt: 1, outcome: "dispatched", run: 44919730318, url: RUN_URL(44919730318) },
      { attempt: 2, outcome: "not-started", reason: "its Publish GitHub Release job was skipped" },
    ],
  });
  assert.ok(first.calls.some((args) => args.join(" ").includes("--attempt 1 --json")));
  // The first attempt failed before its dispatch, and the retry dispatched.
  const retried = fixture({ earlier: [skipped] }).result();
  assert.equal(retried.outcome, "dispatched");
  assert.equal(retried.release, `${RUN_URL(44919164430)} (attempt 2)`);
  // Both attempts dispatched, each its own build: each attempt reads its own job's log.
  const again = RUN_URL(44919800000);
  const twice = fixture({
    earlier: [{}],
    log: jobLog({ printed: [again] }),
    step: { startedAt: "2026-11-21T16:10:00Z", completedAt: "2026-11-21T16:10:02Z" },
    runs: { 44919800000: { ...MACOS_RUN, createdAt: "2026-11-21T16:10:01Z" } },
  });
  assert.deepEqual(twice.result(), {
    outcome: "dispatched",
    run: 44919800000,
    url: again,
    release: `${RUN_URL(44919164430)} (attempt 2)`,
    attempts: [
      { attempt: 1, outcome: "dispatched", run: 44919730318, url: RUN_URL(44919730318) },
      { attempt: 2, outcome: "dispatched", run: 44919800000, url: again },
    ],
  });
  // An attempt whose log could not be read may have dispatched, so a later skip does not make it not started.
  const unread = { log: new Error("gh api failed: HTTP 502") };
  assert.deepEqual(fixture({ earlier: [unread], ...skipped }).result(), {
    outcome: "unverified",
    reason: "gh api failed: HTTP 502",
    release: `${RUN_URL(44919164430)} (attempt 1)`,
    attempts: [
      { attempt: 1, outcome: "unverified", reason: "gh api failed: HTTP 502" },
      { attempt: 2, outcome: "not-started", reason: "its Publish GitHub Release job was skipped" },
    ],
  });
  // Nor does an earlier dispatch name the build when a later attempt may have dispatched another.
  const later = fixture({ earlier: [{}], ...unread }).result();
  assert.equal(later.outcome, "unverified");
  assert.equal(later.release, `${RUN_URL(44919164430)} (attempt 2)`);
  // Not started only when every attempt skipped it.
  assert.deepEqual(fixture({ earlier: [skipped], ...skipped }).result(), {
    outcome: "not-started",
    reason: "its Publish GitHub Release job was skipped",
    release: `${RUN_URL(44919164430)} (attempt 2)`,
    attempts: [
      { attempt: 1, outcome: "not-started", reason: "its Publish GitHub Release job was skipped" },
      { attempt: 2, outcome: "not-started", reason: "its Publish GitHub Release job was skipped" },
    ],
  });
  // A retry that starts while the run is read lends none of its jobs to the attempt before it.
  assert.deepEqual(fixture({ retry: skipped }).result(), {
    outcome: "dispatched",
    run: 44919730318,
    url: RUN_URL(44919730318),
    release,
  });
  // A retry that is still running is pending, before any attempt is read.
  const running = fixture({ earlier: [{}], status: "in_progress" });
  assert.deepEqual(running.result(), {
    outcome: "pending",
    reason: "the release run is in_progress",
    release: `${RUN_URL(44919164430)} (attempt 2)`,
  });
  assert.equal(running.calls.length, 1);
});

test("a gh failure is unverified, with the release run and its attempt wherever gh failed", () => {
  // After the release run's lookup, its own URL and attempt.
  assert.equal(
    JSON.stringify(fixture({ log: jobLog({ printed: [RUN_URL(44919000000)] }) }).result()),
    JSON.stringify({
      outcome: "unverified",
      reason: "gh run view 44919000000 failed: HTTP 404",
      release,
    }),
  );
  assert.deepEqual(fixture({ log: new Error("gh api failed: HTTP 502") }).result(), {
    outcome: "unverified",
    reason: "gh api failed: HTTP 502",
    release,
  });
  // When the lookup itself fails, the run's URL from the repository and its id, the attempt unknown.
  const lookup = releaseMacosRun(REPOSITORY, "44919164430", () => {
    throw new Error("gh run view 44919164430 failed: HTTP 502");
  });
  assert.equal(
    JSON.stringify(lookup),
    JSON.stringify({
      outcome: "unverified",
      reason: "gh run view 44919164430 failed: HTTP 502",
      release: `${RUN_URL(44919164430)} (attempt unknown)`,
    }),
  );
  for (const answer of ["not json", "{}", '{"status":"completed","attempt":"2"}']) {
    const unread = releaseMacosRun(REPOSITORY, "44919164430", () => answer);
    assert.equal(unread.outcome, "unverified", answer);
    assert.equal(unread.release, `${RUN_URL(44919164430)} (attempt unknown)`, answer);
  }
});

test("the command prints the same JSON line when gh cannot run at all", () => {
  // A PATH with no gh on it fails the first lookup, as a missing or broken gh would.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-gh-"));
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^path$/i.test(key)),
    );
    const run = spawnSync(
      process.execPath,
      [path.join(__dirname, "release-macos-run.cjs"), REPOSITORY, "44919164430"],
      { encoding: "utf8", env: { ...env, PATH: empty } },
    );
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(output), ["outcome", "reason", "release"]);
    assert.equal(output.outcome, "unverified");
    assert.match(output.reason, /ENOENT/);
    assert.equal(output.release, `${RUN_URL(44919164430)} (attempt unknown)`);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("the dispatch output reads the version from the step's env and the run from its own output", () => {
  assert.deepEqual(dispatchOutput(jobLog(), REPOSITORY), {
    version: "2026.1121.10",
    run: "44919730318",
  });
  assert.deepEqual(dispatchOutput(jobLog(), "GigaZoro/CodeShipX"), {
    problem: "the dispatch step printed 0 run URLs",
  });
  // A dot in the repository's name matches only a dot.
  assert.deepEqual(dispatchOutput(jobLog(), "Giga.oro/CodeShip"), {
    problem: "the dispatch step printed 0 run URLs",
  });
});
