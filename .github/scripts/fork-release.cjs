#!/usr/bin/env node
// Steps shared by the fork's release workflows, release-fork.yml,
// release-fork-macos.yml and release-fork-retry.yml. Plain CommonJS: their jobs
// run it without installing.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const PUBLIC_CONFIG = [
  ["clerk_publishable_key", "T3CODE_CLERK_PUBLISHABLE_KEY"],
  ["clerk_jwt_template", "T3CODE_CLERK_JWT_TEMPLATE"],
  ["clerk_cli_oauth_client_id", "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID"],
  ["relay_url", "T3CODE_RELAY_URL"],
];
const SAFE_CONFIG_VALUE = /^[A-Za-z0-9._:/-]+$/;
const SAFE_TAG = /^[A-Za-z0-9._-]+$/;
const CARRIED_PREFIX = "../";
const FEED_FILE_LINE = /^(\s*(?:-\s+)?(?:url|path):\s*)(['"]?)([^'"\s]+)\2[ \t]*$/gm;
const FULL_SHA = /^[0-9a-f]{40}$/;
// The macOS build of the latest release: the first build, reruns and replacement dispatches
// share these attempts. A failing run replaces itself up to MACOS_IMMEDIATE_ATTEMPTS, or up
// to MACOS_MAX_ATTEMPTS when GitHub gave its failed jobs no runner; the schedule does the rest.
const MACOS_IMMEDIATE_ATTEMPTS = 3;
const MACOS_MAX_ATTEMPTS = 24;
const MACOS_WORKFLOW = "release-fork-macos.yml";

/**
 * The public T3 Connect identifiers that development builds read, as
 * `output=value` lines for GITHUB_OUTPUT. A missing one is empty: the build
 * then has no T3 Connect.
 */
function publicConfig(envExample) {
  return PUBLIC_CONFIG.map(([output, name]) => {
    const line = envExample.split("\n").find((entry) => entry.startsWith(`${name}=`));
    const value = line === undefined ? "" : line.slice(name.length + 1).trim();
    if (value !== "" && !SAFE_CONFIG_VALUE.test(value)) {
      throw new Error(`${name} is malformed in .env.example.`);
    }
    return `${output}=${value}`;
  });
}

/**
 * Rewrites a release's latest-mac.yml so another release can serve it.
 * electron-updater's GitHub provider resolves each file against
 * `releases/download/<the latest tag>/`, so `../<tag>/<file>` reaches the
 * release that holds the file. A feed carried before already points there.
 */
function carryMacosFeed(feed, tag) {
  if (!SAFE_TAG.test(tag)) {
    throw new Error(`Release tag '${tag}' is not a plain tag name.`);
  }
  let files = 0;
  const carried = feed.replace(FEED_FILE_LINE, (line, key, quote, file) => {
    files += 1;
    return file.startsWith(CARRIED_PREFIX)
      ? line
      : `${key}${quote}${CARRIED_PREFIX}${tag}/${file}${quote}`;
  });
  if (files === 0) {
    throw new Error(`The latest-mac.yml of ${tag} names no files.`);
  }
  return carried;
}

function githubApi(endpoint) {
  return JSON.parse(
    execFileSync("gh", ["api", endpoint], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

function listPages(api, path, field) {
  const result = [];
  for (let page = 1; ; page++) {
    const batch = api(`${path}&per_page=100&page=${page}`);
    const members = batch[field];
    result.push(...members);
    if (result.length >= batch.total_count) return result;
    if (members.length === 0) throw new Error(`Incomplete GitHub ${field} listing.`);
  }
}

function availableArtifact(repo, runId, name, api, now) {
  const artifacts = listPages(
    api,
    `${repo}/actions/runs/${runId}/artifacts?name=${name}`,
    "artifacts",
  );
  return (
    artifacts.filter(
      (a) => a.name === name && a.expired === false && Date.parse(a.expires_at) > now,
    ).length === 1
  );
}

function macosPublisherRun(tag, sha, { repository, defaultBranch, api = githubApi }) {
  if (!repository || !defaultBranch || !SAFE_TAG.test(tag) || !FULL_SHA.test(sha)) {
    throw new Error(
      "A repository, default branch, plain release tag and full release SHA are required.",
    );
  }
  const repo = `repos/${repository}`;
  const release = api(`${repo}/releases/tags/${tag}`);
  if (release.draft || release.tag_name !== tag || release.target_commitish !== sha) {
    throw new Error(`The published release ${tag} does not target ${sha}.`);
  }
  const publishedAt = Date.parse(release.published_at);
  if (!Number.isFinite(publishedAt)) throw new Error(`Release ${tag} has no publication time.`);

  function isReleaseRun(run) {
    return (
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      run.path === ".github/workflows/release-fork.yml" &&
      run.head_branch === defaultBranch &&
      run.head_sha === sha &&
      (run.event === "push" || run.event === "workflow_dispatch")
    );
  }

  const lastLine = (release.body ?? "").trimEnd().split(/\r?\n/).at(-1);
  let runId;
  if (lastLine.startsWith("<!-- codeship-publisher-run:")) {
    const marker = /^<!-- codeship-publisher-run: ([1-9]\d*) -->$/.exec(lastLine);
    if (!marker) throw new Error(`Release ${tag} has an invalid publisher marker.`);
    const run = api(`${repo}/actions/runs/${marker[1]}`);
    if (!isReleaseRun(run) || String(run.id) !== marker[1]) {
      throw new Error(
        `Marked publisher ${marker[1]} is not the release workflow on ${defaultBranch} at ${sha}.`,
      );
    }
    runId = run.id;
  } else {
    // A distinct release of the same SHA can have its own bundle and version.
    const runs = listPages(
      api,
      `${repo}/actions/workflows/release-fork.yml/runs?branch=${encodeURIComponent(defaultBranch)}&head_sha=${sha}`,
      "workflow_runs",
    );
    const publishers = runs.filter(
      (run) =>
        isReleaseRun(run) &&
        listPages(api, `${repo}/actions/runs/${run.id}/jobs?filter=all`, "jobs").some(
          (job) =>
            job.name === "Publish GitHub Release" &&
            job.steps?.some(
              (step) =>
                step.name === "Publish release" &&
                step.conclusion === "success" &&
                Date.parse(step.started_at) <= publishedAt &&
                publishedAt <= Date.parse(step.completed_at),
            ),
        ),
    );
    if (publishers.length !== 1) {
      throw new Error(
        `Found ${publishers.length} publisher runs for ${tag} at ${release.published_at}; expected exactly one.`,
      );
    }
    runId = publishers[0].id;
  }

  return runId;
}

function macosBundleRun(tag, sha, options) {
  const publisher = macosPublisherRun(tag, sha, options);
  const repo = `repos/${options.repository}`;
  if (
    !availableArtifact(
      repo,
      publisher,
      "js-bundle",
      options.api ?? githubApi,
      options.now ?? Date.now(),
    )
  ) {
    throw new Error(
      `Publisher ${publisher} for ${tag} has no unique available js-bundle artifact.`,
    );
  }
  return publisher;
}

function readPreflightLog(repository, job) {
  try {
    return execFileSync(
      "gh",
      [
        "run",
        "view",
        "--repo",
        repository,
        "--job",
        String(job.id),
        "--attempt",
        String(job.run_attempt),
        "--log",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
  } catch {
    // Old job logs expire. Without them we can only dispatch a fresh build from the publisher.
    return "";
  }
}

function copiedPublishersBundle(preflight, publisher, repository, readLog) {
  const passed = (name) =>
    preflight.steps.some((step) => step.name === name && step.conclusion === "success");
  if (!passed("Upload JS bundle")) return false;
  if (passed(`Download JS bundle from publisher ${publisher}`)) return true;

  const step = ["Download the release's JS bundle", "Download the publisher's JS bundle"].find(
    passed,
  );
  if (!step) return false;
  // gh labels each line with its job and step. Read only the download action's runner-printed inputs.
  const prefix = `Preflight\t${step}\t`;
  const lines = readLog(repository, preflight)
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z /, ""));
  const start = lines.findIndex((line) => /^##\[group\]Run actions\/download-artifact@/.test(line));
  const end = lines.indexOf("##[endgroup]", start + 1);
  if (start < 0 || end < 0 || lines[start + 1] !== "with:") return false;
  const inputs = new Map();
  for (const line of lines.slice(start + 2, end)) {
    if (!line.startsWith("  ")) break;
    const match = /^  ([a-z-]+): (.*)$/.exec(line);
    if (!match || inputs.has(match[1])) return false;
    inputs.set(match[1], match[2]);
  }
  return (
    inputs.get("name") === "js-bundle" &&
    inputs.get("run-id") === String(publisher) &&
    !inputs.get("artifact-ids") &&
    (inputs.get("repository") ?? repository) === repository
  );
}

// GitHub cancels a job it finds no runner for after about 15 minutes, before any step ran.
function gotNoRunner(jobs) {
  const failed = jobs.filter((job) =>
    ["failure", "cancelled", "timed_out"].includes(job.conclusion),
  );
  return (
    failed.length > 0 && failed.every((job) => !job.runner_id && (job.steps ?? []).length === 0)
  );
}

/**
 * How to get the macOS app of `tag` built: wait, rerun a failed run, or dispatch a new one.
 * `currentRunId` and `currentAttempt` name the failing run that asks, still in progress:
 * it cannot rerun itself. Without them, the scheduled catch-up asks.
 */
function recoverMacosRun(tag, sha, options) {
  const {
    repository,
    defaultBranch,
    api = githubApi,
    now = Date.now(),
    readLog = readPreflightLog,
    currentRunId,
    currentAttempt,
    publishedAt,
  } = options;
  const repo = `repos/${repository}`;
  const title = `Release (fork) macOS ${tag}`;
  const runs = listPages(
    api,
    `${repo}/actions/workflows/${MACOS_WORKFLOW}/runs?event=workflow_dispatch&head_sha=${sha}`,
    "workflow_runs",
  )
    .filter(
      (r) =>
        r.repository?.full_name === repository &&
        r.head_repository?.full_name === repository &&
        r.event === "workflow_dispatch" &&
        r.head_sha === sha &&
        (r.display_title === title || r.display_title === `${title} (branch dispatch)`),
    )
    .sort((a, b) => b.id - a.id);
  const tagged = runs.filter((r) => r.head_branch === tag && r.display_title === title);
  // A rerun keeps its ID, so the active attempt may belong to an older run.
  const current = tagged.find(
    (r) =>
      String(r.id) === currentRunId &&
      r.run_attempt === currentAttempt &&
      r.status === "in_progress",
  );
  if (currentRunId !== undefined && !current) return { action: "wait" };
  const others = tagged.filter((r) => r !== current);
  if (others.some((r) => r.status !== "completed" || r.conclusion === "success"))
    return { action: "wait" };

  const attempts = runs.reduce((sum, { run_attempt }) => {
    if (!Number.isSafeInteger(run_attempt) || run_attempt < 1)
      throw new Error("Invalid macOS recovery attempt budget.");
    return sum + run_attempt;
  }, 0);
  if (attempts >= MACOS_MAX_ATTEMPTS)
    throw new Error(`${tag} reached its ${MACOS_MAX_ATTEMPTS}-attempt limit across macOS runs.`);
  if (
    current &&
    attempts >= MACOS_IMMEDIATE_ATTEMPTS &&
    !gotNoRunner(
      api(`${repo}/actions/runs/${current.id}/attempts/${current.run_attempt}/jobs?per_page=100`)
        .jobs,
    )
  )
    return { action: "wait" };
  const publisher = macosPublisherRun(tag, sha, { repository, defaultBranch, api });
  // Legacy preflight logs can take 30 seconds each. Read one only for an available
  // artifact being considered for a rerun, after cheaper checks have passed.
  const canReuse = (id, name, preflight) =>
    availableArtifact(repo, id, name, api, now) &&
    copiedPublishersBundle(preflight, publisher, repository, readLog);
  const packagingRuns = [];
  for (const run of others) {
    const jobs = listPages(api, `${repo}/actions/runs/${run.id}/jobs?filter=all`, "jobs");
    // Rerunning failed jobs can leave the successful preflight and signed build in an earlier attempt.
    const latest = new Map();
    for (const job of jobs) {
      if (!latest.has(job.name) || latest.get(job.name).id < job.id) latest.set(job.name, job);
    }
    const preflight = latest.get("Preflight");
    if (preflight?.conclusion !== "success") continue;
    const failed = [...latest.values()].filter(
      (j) =>
        j.name !== "Recover the macOS build" &&
        !["success", "skipped", "neutral"].includes(j.conclusion),
    );
    if (!failed.length) continue;
    if (failed.length === 1 && failed[0].name === "Attach to the release") {
      const signedBuild = [...latest.values()].some(
        (job) =>
          job.conclusion === "success" &&
          job.steps?.some(
            (step) => step.name === "Upload build artifacts" && step.conclusion === "success",
          ),
      );
      if (signedBuild && canReuse(run.id, "desktop-mac-arm64", preflight))
        return { action: "rerun", id: run.id };
    } else {
      packagingRuns.push({ id: run.id, preflight });
    }
  }
  // Rerun packaging only after every candidate for attaching an existing signed build has been checked.
  for (const { id, preflight } of packagingRuns) {
    if (canReuse(id, "js-bundle", preflight)) return { action: "rerun", id };
  }
  if (!Number.isFinite(publishedAt)) throw new Error(`Release ${tag} has no publication time.`);
  // The release dispatches its own first build; give that dispatch time to appear.
  if (!current && now - publishedAt < 600_000) return { action: "wait" };
  if (!availableArtifact(repo, publisher, "js-bundle", api, now)) {
    throw new Error(
      `No recoverable macOS artifact and no unique available js-bundle from publisher ${publisher} for ${tag}.`,
    );
  }
  return { action: "dispatch", id: publisher };
}

function readReleaseAsset(repository, id) {
  return execFileSync(
    "gh",
    ["api", "-H", "Accept: application/octet-stream", `repos/${repository}/releases/assets/${id}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30_000 },
  );
}

/**
 * The macOS recovery of the latest release, with its tag: done once the release serves its
 * own latest-mac.yml (until then it carries the previous release's), else recoverMacosRun's
 * plan. Macs update only to the latest release, so older ones are left alone.
 */
function recoverLatestMacos(options) {
  const { repository, api = githubApi } = options;
  const readAsset = options.readAsset ?? ((id) => readReleaseAsset(repository, id));
  const release = api(`repos/${repository}/releases/latest`);
  const tag = release.tag_name;
  const sha = release.target_commitish;
  if (typeof tag !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) || !FULL_SHA.test(sha)) {
    throw new Error(`The latest release ${tag} at ${sha} is not a fork release.`);
  }
  const feed = (release.assets ?? []).find((asset) => asset.name === "latest-mac.yml");
  if (
    feed &&
    readAsset(feed.id)
      .split(/\r?\n/)
      .includes(`version: ${tag.slice(1)}`)
  ) {
    return { action: "done", tag };
  }
  const plan = recoverMacosRun(tag, sha, {
    ...options,
    api,
    publishedAt: Date.parse(release.published_at),
  });
  return { ...plan, tag };
}

/** The gh arguments that carry out a recovery plan, or null when it needs none. */
function macosRecoveryCommand(plan, repository) {
  if (plan.action === "rerun") {
    return ["run", "rerun", String(plan.id), "--failed", "--repo", repository];
  }
  if (plan.action === "dispatch") {
    return [
      "workflow",
      "run",
      MACOS_WORKFLOW,
      "--repo",
      repository,
      "--ref",
      plan.tag,
      "-f",
      `version=${plan.tag.slice(1)}`,
      "-f",
      `bundle_run=${plan.id}`,
    ];
  }
  if (plan.action === "done" || plan.action === "wait") return null;
  throw new Error(`Unexpected macOS recovery decision ${plan.action}.`);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "public-config" && args.length <= 1) {
    const [file = ".env.example"] = args;
    process.stdout.write(`${publicConfig(fs.readFileSync(file, "utf8")).join("\n")}\n`);
    return;
  }
  if (command === "carry-macos-feed" && args.length === 2) {
    const [tag, file] = args;
    process.stdout.write(carryMacosFeed(fs.readFileSync(file, "utf8"), tag));
    return;
  }
  if (command === "macos-bundle" && args.length === 2) {
    const run = macosBundleRun(args[0], args[1], {
      repository: process.env.GITHUB_REPOSITORY,
      defaultBranch: process.env.DEFAULT_BRANCH,
    });
    process.stdout.write(`${run}\n`);
    return;
  }
  if (command === "recover-macos" && args.length === 0) {
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY is required.");
    const plan = recoverLatestMacos({
      repository,
      defaultBranch: process.env.DEFAULT_BRANCH,
      currentRunId: process.env.RUN_ID || undefined,
      currentAttempt: Number(process.env.RUN_ATTEMPT),
    });
    process.stdout.write(
      `${plan.tag}: ${plan.action}${plan.id === undefined ? "" : ` ${plan.id}`}\n`,
    );
    const ghArgs = macosRecoveryCommand(plan, repository);
    if (ghArgs) execFileSync("gh", ghArgs, { stdio: "inherit", timeout: 60_000 });
    return;
  }
  throw new Error(
    "Usage: fork-release.cjs public-config [.env.example] | carry-macos-feed <tag> <latest-mac.yml> | macos-bundle <tag> <sha> | recover-macos",
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  carryMacosFeed,
  macosBundleRun,
  macosRecoveryCommand,
  publicConfig,
  recoverLatestMacos,
  recoverMacosRun,
};
