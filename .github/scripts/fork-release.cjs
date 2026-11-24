#!/usr/bin/env node
// Steps shared by the fork's release workflows, release-fork.yml and
// release-fork-macos.yml. Plain CommonJS: their jobs run it without installing.
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

function macosBundleRun(
  tag,
  sha,
  { repository, defaultBranch, api = githubApi, now = Date.now() },
) {
  if (!repository || !defaultBranch || !SAFE_TAG.test(tag) || !/^[0-9a-f]{40}$/.test(sha)) {
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

  function list(path, field) {
    const result = [];
    for (let page = 1; ; page++) {
      const batch = api(`${repo}/${path}&per_page=100&page=${page}`);
      const members = batch[field];
      result.push(...members);
      if (result.length >= batch.total_count) return result;
      if (members.length === 0) throw new Error(`Incomplete GitHub ${field} listing for ${tag}.`);
    }
  }
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
    const runs = list(
      `actions/workflows/release-fork.yml/runs?branch=${encodeURIComponent(defaultBranch)}&head_sha=${sha}`,
      "workflow_runs",
    );
    const publishers = runs.filter(
      (run) =>
        isReleaseRun(run) &&
        list(`actions/runs/${run.id}/jobs?filter=all`, "jobs").some(
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

  const artifacts = list(`actions/runs/${runId}/artifacts?name=js-bundle`, "artifacts");
  const bundles = artifacts.filter(
    (artifact) =>
      artifact.name === "js-bundle" &&
      artifact.expired === false &&
      Date.parse(artifact.expires_at) > now,
  );
  if (bundles.length !== 1) {
    throw new Error(
      `Publisher ${runId} for ${tag} has ${bundles.length} available js-bundle artifacts (missing, expired or ambiguous).`,
    );
  }
  return runId;
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
  throw new Error(
    "Usage: fork-release.cjs public-config [.env.example] | carry-macos-feed <tag> <latest-mac.yml> | macos-bundle <tag> <sha>",
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

module.exports = { carryMacosFeed, macosBundleRun, publicConfig };
