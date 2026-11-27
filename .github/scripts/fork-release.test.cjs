const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  macosBundleRun,
  macosRecoveryCommand,
  recoverLatestMacos,
  recoverMacosRun,
} = require("./fork-release.cjs");

const repository = "Example/Fork";
const defaultBranch = "main";
const tag = "v2026.1124.3";
const sha = "b".repeat(40);
const time = "2026-11-24T08:23:12Z";
const now = Date.parse(time);
const release = { tag_name: tag, target_commitish: sha, published_at: time, body: "Notes" };
const marked = { ...release, body: "Notes\r\n\r\n<!-- codeship-publisher-run: 42 -->\r\n" };
const run = {
  id: 42,
  event: "push",
  path: ".github/workflows/release-fork.yml",
  head_branch: defaultBranch,
  head_sha: sha,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
};
const bundle = { name: "js-bundle", expired: false, expires_at: "2026-11-27T12:00:00Z" };
const publication = {
  name: "Publish GitHub Release",
  steps: [
    {
      name: "Publish release",
      conclusion: "success",
      started_at: "2026-11-24T08:22:48Z",
      completed_at: time,
    },
  ],
};
const releasePath = `releases/tags/${tag}`;
const runPath = `actions/workflows/release-fork.yml/runs?branch=main&head_sha=${sha}&per_page=100&page=`;
const jobsPath = (id) => `actions/runs/${id}/jobs?filter=all&per_page=100&page=`;
const artifactsPath = (id) => `actions/runs/${id}/artifacts?name=js-bundle&per_page=100&page=`;

function lookup(responses) {
  return macosBundleRun(tag, sha, {
    repository,
    defaultBranch,
    now,
    api: (endpoint) => {
      const prefix = `repos/${repository}/`;
      assert.ok(endpoint.startsWith(prefix), endpoint);
      const key = endpoint.slice(prefix.length);
      assert.ok(Object.hasOwn(responses, key), `Unexpected API request ${key}`);
      return responses[key];
    },
  });
}

test("a marked release gets its available bundle from the specified publisher", () => {
  assert.equal(
    lookup({
      [releasePath]: marked,
      "actions/runs/42": run,
      [artifactsPath(42) + "1"]: { total_count: 1, artifacts: [bundle] },
    }),
    42,
  );
});

test("a bad publisher marker or mismatched release source fails without selecting a substitute", () => {
  assert.throws(
    () => lookup({ [releasePath]: { ...marked, target_commitish: "a".repeat(40) } }),
    /does not target/,
  );
  assert.throws(
    () => lookup({ [releasePath]: { ...release, body: "<!-- codeship-publisher-run: 4a2 -->" } }),
    /invalid publisher marker/,
  );
  for (const change of [
    { id: 43 },
    { path: ".github/workflows/other.yml" },
    { head_branch: "other" },
    { head_sha: "a".repeat(40) },
    { repository: { full_name: "Other/Fork" } },
    { head_repository: { full_name: "Other/Fork" } },
    { event: "pull_request" },
  ]) {
    assert.throws(
      () => lookup({ [releasePath]: marked, "actions/runs/42": { ...run, ...change } }),
      /Marked publisher 42 is not the release workflow/,
    );
  }
});

function legacy() {
  return {
    [releasePath]: release,
    [runPath + "1"]: { total_count: 2, workflow_runs: [{ ...run, id: 41 }] },
    [runPath + "2"]: { total_count: 2, workflow_runs: [run] },
    [jobsPath(41) + "1"]: {
      total_count: 1,
      jobs: [
        {
          ...publication,
          steps: [{ ...publication.steps[0], completed_at: "2026-11-24T08:23:11Z" }],
        },
      ],
    },
    [jobsPath(42) + "1"]: { total_count: 2, jobs: [{ name: "Preflight" }] },
    [jobsPath(42) + "2"]: { total_count: 2, jobs: [publication] },
    [artifactsPath(42) + "1"]: { total_count: 1, artifacts: [bundle] },
  };
}

test("legacy releases use the successful publication step across runs, attempts and pages", () => {
  assert.equal(lookup(legacy()), 42);
});

test("an absent or ambiguous successful publication never selects a same-commit bundle", () => {
  const fixtures = legacy();
  fixtures[jobsPath(41) + "1"].jobs = [publication];
  assert.throws(() => lookup(fixtures), /Found 2 publisher runs/);
  const failedStep = {
    ...publication,
    steps: [{ ...publication.steps[0], conclusion: "failure" }],
  };
  fixtures[jobsPath(41) + "1"].jobs = [failedStep];
  fixtures[jobsPath(42) + "2"].jobs = [failedStep];
  assert.throws(() => lookup(fixtures), /Found 0 publisher runs/);
});

test("a missing or expired publisher artifact never falls back to a different producer", () => {
  for (const contents of [[], [{ ...bundle, expired: true }], [{ ...bundle, expires_at: time }]]) {
    const unavailable = { total_count: contents.length, artifacts: contents };
    for (const source of [legacy(), { [releasePath]: marked, "actions/runs/42": run }]) {
      assert.throws(
        () => lookup({ ...source, [artifactsPath(42) + "1"]: unavailable }),
        /Publisher 42.*no unique available js-bundle/,
      );
    }
  }
});

const firstMac = {
  ...run,
  id: 502,
  event: "workflow_dispatch",
  path: ".github/workflows/release-fork-macos.yml",
  head_branch: tag,
  display_title: `Release (fork) macOS ${tag}`,
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
};
const macRunsPath = `actions/workflows/release-fork-macos.yml/runs?event=workflow_dispatch&head_sha=${sha}&per_page=100&page=1`;
const publisherDownload = "Download JS bundle from publisher 42";
const oldDownload = "Download the release's JS bundle";
const ok = (name) => ({ name, conclusion: "success" });
const preflight = (download) => ({
  id: 101,
  run_attempt: 1,
  name: "Preflight",
  conclusion: "success",
  steps: [ok(download), ok("Upload JS bundle")],
});
const failedBuild = { id: 102, name: "Desktop macOS arm64 / Build", conclusion: "failure" };
const failedAttach = { id: 103, name: "Attach to the release", conclusion: "failure" };
const page = (field, items) => ({ total_count: items.length, [field]: items });
const artifact = (id, name) => `actions/runs/${id}/artifacts?name=${name}&per_page=100&page=1`;
const noRunner = {
  id: 104,
  name: "metadata_mac / build",
  conclusion: "cancelled",
  runner_id: 0,
  steps: [],
};
const asking = { ...firstMac, status: "in_progress", conclusion: null };
/** Recovery as the scheduled catch-up asks it, or as the failing run asks it with `fromRun`. */
const recovery = ({
  runs = [firstMac],
  jobs = [preflight(publisherDownload), failedBuild],
  responses,
  readLog = () => "",
  fromRun = false,
  currentAttempt = runs[0]?.run_attempt,
  currentRunId = String(runs[0]?.id),
  currentJobs = [
    preflight(publisherDownload),
    { ...failedBuild, runner_id: 7, steps: [ok("Build")] },
  ],
  elapsed = 600_001,
} = {}) => {
  const apiInputs = {
    [releasePath]: marked,
    "actions/runs/42": run,
    [macRunsPath]: page("workflow_runs", runs),
    [jobsPath(502) + "1"]: page("jobs", jobs),
    [`actions/runs/${currentRunId}/attempts/${currentAttempt}/jobs?per_page=100`]: {
      jobs: currentJobs,
    },
    ...responses,
  };
  return recoverMacosRun(tag, sha, {
    repository,
    defaultBranch,
    now,
    readLog,
    publishedAt: now - elapsed,
    ...(fromRun ? { currentRunId, currentAttempt } : {}),
    api: (endpoint) => {
      const path = endpoint.replace(`repos/${repository}/`, "");
      assert.ok(Object.hasOwn(apiInputs, path), `Unexpected API request ${path}`);
      return apiInputs[path];
    },
  });
};
const ready = (id, name) => ({ [artifact(id, name)]: page("artifacts", [{ ...bundle, name }]) });
const missing = (id, name) => ({ [artifact(id, name)]: page("artifacts", []) });
const legacyLog = (source, changes = {}) => {
  const prefix = "Preflight\t" + (changes.step ?? oldDownload) + "\t";
  return (
    [
      "##[group]Run actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      "with:",
      "  name: js-bundle",
      "  path: js-bundle",
      `  run-id: ${source}`,
      "  github-token: ***",
      "  repository: " + (changes.repo ?? repository),
      "##[endgroup]",
    ]
      // gh keeps the byte-order mark from the first line of a per-step log after its step label.
      .map(
        (line, index) =>
          prefix +
          (index === 0 && changes.bom !== false ? "\uFEFF" : "") +
          "2026-11-08T09:31:51.8214420Z " +
          line,
      )
      .join("\n")
  );
};

test("a legacy packaging failure reuses its bundle only when the actual download identifies the publisher", () => {
  const jobs = [preflight(oldDownload), failedBuild];
  for (const log of [
    "",
    legacyLog(41),
    legacyLog(42, { step: "other" }),
    legacyLog(42, { step: "UNKNOWN STEP" }),
    legacyLog(42, { repo: "Other/Fork" }),
  ]) {
    assert.deepEqual(
      recovery({
        jobs,
        readLog: () => log,
        responses: { ...ready(502, "js-bundle"), ...ready(42, "js-bundle") },
      }),
      {
        action: "dispatch",
        id: 42,
      },
    );
  }
  for (const bom of [true, false]) {
    assert.deepEqual(
      recovery({ jobs, readLog: () => legacyLog(42, { bom }), responses: ready(502, "js-bundle") }),
      { action: "rerun", id: 502 },
    );
  }
});

test("an attach-only rerun requires the signed artifact and a verified preflight and survives expiry of both JS bundles", () => {
  const jobs = [
    preflight(oldDownload),
    { ...failedBuild, conclusion: "success", steps: [ok("Upload build artifacts")] },
    failedAttach,
    { id: 105, name: "Recover the macOS build", conclusion: "failure" },
  ];
  assert.deepEqual(
    recovery({ jobs, readLog: () => legacyLog(42), responses: ready(502, "desktop-mac-arm64") }),
    { action: "rerun", id: 502 },
  );
  assert.throws(
    () =>
      recovery({
        jobs,
        readLog: () => legacyLog(41),
        responses: { ...ready(502, "desktop-mac-arm64"), ...missing(42, "js-bundle") },
      }),
    /No recoverable macOS artifact/,
  );
  assert.deepEqual(
    recovery({
      jobs,
      readLog: () => legacyLog(42),
      responses: { ...missing(502, "desktop-mac-arm64"), ...ready(42, "js-bundle") },
    }),
    { action: "dispatch", id: 42 },
  );
  assert.deepEqual(
    recovery({
      jobs: [...jobs, { ...preflight(publisherDownload), id: 111, conclusion: "failure" }],
      readLog: () => legacyLog(42),
      responses: ready(42, "js-bundle"),
    }),
    { action: "dispatch", id: 42 },
  );
});

test("the final scheduled attempt attaches a signed build before retrying packaging", () => {
  const runs = [firstMac, { ...firstMac, id: 501, run_attempt: 22 }];
  const olderJobs = [
    preflight(publisherDownload),
    {
      ...failedBuild,
      conclusion: "success",
      steps: [ok("Upload build artifacts")],
    },
    failedAttach,
  ];
  const responses = {
    [jobsPath(501) + "1"]: page("jobs", olderJobs),
    ...ready(502, "js-bundle"),
  };
  assert.deepEqual(
    recovery({
      runs,
      responses: { ...responses, ...ready(501, "desktop-mac-arm64") },
    }),
    { action: "rerun", id: 501 },
  );
  assert.deepEqual(
    recovery({
      runs,
      responses: { ...responses, ...missing(501, "desktop-mac-arm64") },
    }),
    { action: "rerun", id: 502 },
  );
});

test("recovery reads only the qualifying legacy log when 23 runs have finished", () => {
  const runs = Array.from({ length: 23 }, (_, i) => ({ ...firstMac, id: firstMac.id - i }));
  for (const signed of [false, true]) {
    const chosen = signed ? runs.at(-1).id : firstMac.id;
    const responses = {};
    for (const { id } of runs) {
      const jobs = [{ ...preflight(oldDownload), id }];
      if (signed && id === chosen) {
        jobs.push(
          { ...failedBuild, conclusion: "success", steps: [ok("Upload build artifacts")] },
          failedAttach,
        );
        Object.assign(responses, ready(id, "desktop-mac-arm64"));
      } else {
        jobs.push(failedBuild);
        Object.assign(responses, ready(id, "js-bundle"));
      }
      responses[jobsPath(id) + "1"] = page("jobs", jobs);
    }
    const logs = [];
    const decision = recovery({
      runs,
      responses,
      readLog: (_, job) => {
        assert.equal(job.id, chosen, "read a legacy log for a run that cannot be selected");
        logs.push(job.id);
        return legacyLog(42);
      },
    });
    assert.deepEqual(decision, { action: "rerun", id: chosen });
    assert.deepEqual(logs, [chosen]);
  }
});

test("an expired artifact never requires a legacy log download", () => {
  for (const attach of [false, true]) {
    const jobs = attach
      ? [
          preflight(oldDownload),
          { ...failedBuild, conclusion: "success", steps: [ok("Upload build artifacts")] },
          failedAttach,
        ]
      : [preflight(oldDownload), failedBuild];
    const responses = {
      ...missing(502, attach ? "desktop-mac-arm64" : "js-bundle"),
      ...ready(42, "js-bundle"),
    };
    const result = recovery({
      jobs,
      responses,
      readLog: () => assert.fail("read a log without an available artifact"),
    });
    assert.deepEqual(result, { action: "dispatch", id: 42 });
  }
});

test("immediate and scheduled recovery count every attempt and replacement for the release at both limits", () => {
  assert.throws(
    () => recovery({ runs: [{ ...firstMac, run_attempt: undefined }] }),
    /Invalid macOS recovery attempt budget/,
  );
  for (const legacySource of [false, true]) {
    const jobs = [preflight(legacySource ? oldDownload : publisherDownload), failedBuild];
    for (const count of [2, 3, 23, 24]) {
      const runs = [
        firstMac,
        {
          ...firstMac,
          id: 501,
          head_branch: "main",
          display_title: firstMac.display_title + " (branch dispatch)",
          run_attempt: count - 1,
        },
      ];
      const opts = {
        runs,
        jobs,
        responses: { ...ready(42, "js-bundle"), ...ready(502, "js-bundle") },
      };
      const scheduled = legacySource
        ? { action: "dispatch", id: 42 }
        : { action: "rerun", id: 502 };
      if (count >= 24) assert.throws(() => recovery(opts), /24-attempt limit/);
      else assert.deepEqual(recovery(opts), scheduled);
      // A run that asks is still in progress, so it cannot rerun itself: it is replaced.
      const fromRun = { ...opts, runs: [asking, runs[1]], fromRun: true };
      if (count >= 24) assert.throws(() => recovery(fromRun), /24-attempt limit/);
      else
        assert.deepEqual(
          recovery(fromRun),
          count >= 3 ? { action: "wait" } : { action: "dispatch", id: 42 },
        );
    }
  }
  const rejections = [asking, { ...firstMac, id: 501 }, { ...firstMac, id: 500 }];
  assert.deepEqual(recovery({ runs: rejections, fromRun: true }), { action: "wait" });
});

test("a pending build, superseded run or newly published release does not create another build", () => {
  assert.deepEqual(recovery({ runs: [{ ...firstMac, status: "queued" }] }), { action: "wait" });
  const pendingOther = [asking, { ...firstMac, id: 501, status: "queued" }];
  assert.deepEqual(recovery({ runs: pendingOther, fromRun: true }), { action: "wait" });
  const runs = [asking];
  assert.deepEqual(recovery({ runs, fromRun: true, currentRunId: "501" }), { action: "wait" });
  assert.deepEqual(recovery({ runs, fromRun: true, currentAttempt: 2 }), { action: "wait" });
  assert.deepEqual(recovery({ runs: [], elapsed: 599_999 }), { action: "wait" });
  assert.deepEqual(recovery({ runs: [], responses: ready(42, "js-bundle") }), {
    action: "dispatch",
    id: 42,
  });
});

test("a run GitHub gave no runner replaces itself at once, up to the attempt limit", () => {
  // GitHub starts no workflow_run run for a run GITHUB_TOKEN dispatched, so nothing else
  // hears of this failure until the schedule fires, hours later under load.
  for (const count of [1, 3, 23, 24]) {
    const runs = [{ ...asking, run_attempt: count }];
    const call = () =>
      recovery({
        runs,
        fromRun: true,
        currentJobs: [
          preflight(publisherDownload),
          noRunner,
          { name: "Recover", conclusion: null },
        ],
        responses: ready(42, "js-bundle"),
        elapsed: 0,
      });
    if (count >= 24) assert.throws(call, /24-attempt limit/);
    else assert.deepEqual(call(), { action: "dispatch", id: 42 });
  }
  // Rerunning failed jobs keeps the original run ID, even after a replacement has failed.
  assert.deepEqual(
    recovery({
      runs: [firstMac, { ...asking, id: 501, run_attempt: 2 }],
      fromRun: true,
      currentRunId: "501",
      currentAttempt: 2,
      currentJobs: [noRunner],
      responses: ready(502, "js-bundle"),
    }),
    { action: "rerun", id: 502 },
  );
  // A cancellation after acquiring a runner (for example a manual cancel) must not respawn itself.
  assert.deepEqual(
    recovery({
      runs: [asking],
      fromRun: true,
      currentJobs: [
        preflight(publisherDownload),
        { ...failedBuild, conclusion: "cancelled", runner_id: 7, steps: [ok("Build")] },
      ],
      responses: ready(42, "js-bundle"),
    }),
    { action: "wait" },
  );
});

test("recovery of the latest release ends once it serves its own macOS feed", () => {
  const feed = (version) => `version: ${version}\r\npath: T3-Code-${version}-arm64.zip\r\n`;
  const latest = (assets) => ({ ...marked, assets });
  const recoverWith = (assets, asset) =>
    recoverLatestMacos({
      repository,
      defaultBranch,
      now: now + 600_001,
      readAsset: (id) => {
        assert.equal(id, 7);
        return asset;
      },
      api: (endpoint) => {
        const path = endpoint.replace(`repos/${repository}/`, "");
        if (path === "releases/latest") return latest(assets);
        if (path === macRunsPath) return page("workflow_runs", []);
        if (path === releasePath) return marked;
        if (path === "actions/runs/42") return run;
        if (path === artifact(42, "js-bundle")) return page("artifacts", [bundle]);
        assert.fail(`Unexpected API request ${path}`);
      },
    });
  const macFeed = [{ id: 7, name: "latest-mac.yml" }];
  assert.deepEqual(recoverWith(macFeed, feed("2026.1124.3")), { action: "done", tag });
  // A release carries the previous release's feed until its own build attaches.
  const replacement = { action: "dispatch", id: 42, tag };
  assert.deepEqual(recoverWith(macFeed, feed("2026.1124.2")), replacement);
  assert.deepEqual(recoverWith([]), replacement);
});

test("a recovery plan dispatches the macOS build from the release tag or reruns failed jobs", () => {
  assert.deepEqual(macosRecoveryCommand({ action: "dispatch", id: 42, tag }, repository), [
    "workflow",
    "run",
    "release-fork-macos.yml",
    "--repo",
    repository,
    "--ref",
    tag,
    "-f",
    "version=2026.1124.3",
    "-f",
    "bundle_run=42",
  ]);
  assert.deepEqual(macosRecoveryCommand({ action: "rerun", id: 502, tag }, repository), [
    "run",
    "rerun",
    "502",
    "--failed",
    "--repo",
    repository,
  ]);
  assert.equal(macosRecoveryCommand({ action: "wait", tag }, repository), null);
  assert.equal(macosRecoveryCommand({ action: "done", tag }, repository), null);
  assert.throws(() => macosRecoveryCommand({ action: "other", tag }, repository), /Unexpected/);
});
