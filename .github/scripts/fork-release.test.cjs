const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macosBundleRun } = require("./fork-release.cjs");

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
        /Publisher 42.*0 available js-bundle/,
      );
    }
  }
});
