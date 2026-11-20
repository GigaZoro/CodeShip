// A push to main runs check:changed on Windows (.github/workflows/windows-check-fork.yml), the one place a change landed
// from macOS or Linux meets Windows. A red run there reaches no one unless the lander waits for it, so landing waits
// here and reports the run's failures to the chat that can fix them. `node .github/scripts/windows-check.cjs <commit>`
// waits for one landed commit's run: exit 0 when it passed or no Windows check runs for the repository, 3 otherwise.
const { spawnSync } = require("node:child_process");

const WORKFLOW = "windows-check-fork.yml";
const API = "https://api.github.com";
// Without a token GitHub allows 60 requests an hour per address, which every lander on the machine shares.
const POLL_MS = 3 * 60 * 1000;
// GitHub creates a push's run within seconds, even while it waits for a runner.
const START_LIMIT_MS = 15 * 60 * 1000;
// The job may run for the workflow's 360 minutes after it waits for a runner.
const FINISH_LIMIT_MS = 400 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const MAX_FAILURES = 20;
const NOT_PASSED_EXIT = 3;

/** The GitHub owner and repository a remote URL points at, or null for any other host. */
function githubRepository(url) {
  const match =
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url,
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

async function get(fetch, path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "t3-landing-turn",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, response, body: response.ok ? await response.json() : null };
}

async function failuresOf(fetch, repository, run) {
  const jobs = await get(fetch, `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=30`);
  if (!jobs.body) return [`GitHub answered ${jobs.status} for the run's jobs.`];
  const failures = [];
  for (const job of jobs.body.jobs) {
    if (job.conclusion === "success" || job.conclusion === "skipped") continue;
    for (const step of job.steps ?? []) {
      if (step.conclusion === "failure") failures.push(`${job.name}: step "${step.name}" failed`);
    }
    const annotations = await get(
      fetch,
      `/repos/${repository}/check-runs/${job.id}/annotations?per_page=50`,
    );
    for (const annotation of annotations.body ?? []) {
      if (annotation.annotation_level !== "failure") continue;
      // GitHub files a job-level message, such as an exceeded time limit, under the path ".github".
      const where =
        annotation.path === ".github" ? "" : `${annotation.path}:${annotation.start_line} `;
      failures.push(`${where}${annotation.message.split("\n")[0]}`);
    }
  }
  return failures.slice(0, MAX_FAILURES);
}

/**
 * Waits for the Windows check of `commit` (a full SHA) on `repository` ("owner/name") and returns its result:
 * `passed`, `failed` (with `failures`), `none` when the repository runs no Windows check, `not-started` when no
 * run appeared, or `unfinished` when it did not finish within the job's time limit. Waits on the monotonic clock.
 */
async function waitForWindowsCheck({
  repository,
  commit,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => performance.now(),
}) {
  const started = clock();
  const runs = `/repos/${repository}/actions/workflows/${WORKFLOW}/runs?head_sha=${commit}&event=push&per_page=1`;
  let run = null;
  let problem = null;
  for (;;) {
    let wait = POLL_MS;
    try {
      const listing = await get(fetch, runs);
      // A repository without the workflow, or one GitHub does not show without a token, has no Windows check.
      if (listing.status === 404) {
        return { status: "none", reason: `GitHub shows no ${WORKFLOW} for ${repository}.` };
      }
      if (listing.body) {
        run = listing.body.workflow_runs[0] ?? null;
        problem = null;
      } else {
        problem = `GitHub answered ${listing.status}.`;
        const retryAfter = Number(listing.response.headers.get("retry-after"));
        if (retryAfter > 0) wait = Math.max(wait, retryAfter * 1000);
      }
    } catch (error) {
      problem = `GitHub could not be reached: ${error.message}`;
    }
    if (run?.status === "completed") {
      const url = run.html_url;
      if (run.conclusion === "success") return { status: "passed", url };
      if (run.conclusion === "skipped") {
        return { status: "none", url, reason: "The Windows check is skipped in this repository." };
      }
      let failures;
      try {
        failures = await failuresOf(fetch, repository, run);
      } catch (error) {
        failures = [`Its failures could not be read: ${error.message}`];
      }
      return { status: "failed", url, conclusion: run.conclusion, failures };
    }
    const elapsed = clock() - started;
    if (!run && !problem && elapsed >= START_LIMIT_MS) {
      return { status: "not-started", reason: `No ${WORKFLOW} run started for ${commit}.` };
    }
    if (elapsed >= FINISH_LIMIT_MS) {
      return {
        status: "unfinished",
        url: run?.html_url,
        reason: problem ?? "It is still running.",
      };
    }
    await sleep(wait);
  }
}

/** Waits for the Windows check of a commit pushed to `remote`; a remote off GitHub has none. */
async function windowsCheck({ cwd, remote, commit, ...options }) {
  const url = spawnSync("git", ["-C", cwd, "remote", "get-url", remote], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim();
  const repository = githubRepository(url);
  if (!repository) return { status: "none", reason: `${remote} is not a GitHub repository.` };
  return waitForWindowsCheck({ repository, commit, ...options });
}

const passed = (result) => result.status === "passed" || result.status === "none";

async function main(argv) {
  const [commit] = argv;
  if (!commit) {
    console.error("usage: windows-check.cjs <commit>");
    return 2;
  }
  const cwd = process.cwd();
  const resolved = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", `${commit}^{commit}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (resolved.status !== 0) throw new Error(`windows check: unknown commit ${commit}`);
  const result = await windowsCheck({ cwd, remote: "origin", commit: resolved.stdout.trim() });
  console.log(JSON.stringify(result));
  return passed(result) ? 0 : NOT_PASSED_EXIT;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  NOT_PASSED_EXIT,
  githubRepository,
  passed,
  waitForWindowsCheck,
  windowsCheck,
};
