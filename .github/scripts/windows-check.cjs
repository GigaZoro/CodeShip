// A push to main runs check:changed on Windows (.github/workflows/windows-check-fork.yml), the one place a change landed
// from macOS or Linux meets Windows. A red run there reaches no one unless the lander waits for it, so after landing the
// ship skill and the upstream sync run `node .github/scripts/windows-check.cjs <commit>`: it waits for that commit's run
// and prints its result, exiting 0 when it passed or no Windows check runs for the repository, 3 otherwise.
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
  const scp = /^[^@/:]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (scp) return `${scp[1]}/${scp[2]}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function request(fetch, path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "t3-landing-turn",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) await response.body?.cancel();
  return {
    status: response.status,
    headers: response.headers,
    body: response.ok ? await response.json() : null,
  };
}

/** How long GitHub asks this address to wait before its next request; `now` is the wall clock its reset time is on. */
function backoffMs(headers, now) {
  const retryAfter = Number(headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-remaining") === "0" && reset > 0) {
    return Math.max(0, reset * 1000 - now());
  }
  return 0;
}

async function failuresOf(fetch, repository, run) {
  const failures = [];
  const read = async (path, what) => {
    try {
      const answer = await request(fetch, path);
      if (answer.body) return answer.body;
      failures.push(`GitHub answered ${answer.status} for ${what}.`);
    } catch (error) {
      failures.push(`GitHub could not be reached for ${what}: ${error.message}`);
    }
    return null;
  };
  const jobs = await read(
    `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=30`,
    "the run's jobs",
  );
  for (const job of jobs?.jobs ?? []) {
    if (job.conclusion === "success" || job.conclusion === "skipped") continue;
    for (const step of job.steps ?? []) {
      if (step.conclusion === "failure") failures.push(`${job.name}: step "${step.name}" failed`);
    }
    const annotations = await read(
      `/repos/${repository}/check-runs/${job.id}/annotations?per_page=50`,
      `the annotations of ${job.name}`,
    );
    for (const annotation of annotations ?? []) {
      if (annotation.annotation_level !== "failure") continue;
      // GitHub files a job-level message, such as an exceeded time limit, under the path ".github".
      const where =
        annotation.path === ".github" ? "" : `${annotation.path}:${annotation.start_line} `;
      const text = (annotation.message ?? annotation.title ?? "").split("\n")[0] || "(no message)";
      failures.push(`${where}${text}`);
    }
  }
  return failures.slice(0, MAX_FAILURES);
}

/**
 * Waits for the Windows check of `commit` (a full SHA) on `repository` ("owner/name") and returns its result with a
 * `url` to read: `passed`, `failed` (with `failures`), `none` when the repository runs no Windows check, `not-started`
 * when no run appeared, or `unfinished` when it did not finish within the job's time limit. Waits on the monotonic
 * `clock`; `now` is the wall clock, read only against GitHub's rate-limit reset time.
 */
async function waitForWindowsCheck({
  repository,
  commit,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  clock = () => performance.now(),
  now = () => Date.now(),
}) {
  const started = clock();
  const workflowUrl = `https://github.com/${repository}/actions/workflows/${WORKFLOW}`;
  const listing = `/repos/${repository}/actions/workflows/${WORKFLOW}/runs?head_sha=${commit}&event=push&per_page=1`;
  let run = null;
  let problem = null;
  for (;;) {
    let wait = POLL_MS;
    try {
      const answer = await request(
        fetch,
        run ? `/repos/${repository}/actions/runs/${run.id}` : listing,
      );
      wait = Math.max(wait, backoffMs(answer.headers, now));
      if (answer.body) {
        run = run ? answer.body : (answer.body.workflow_runs[0] ?? null);
        problem = null;
      } else if (answer.status === 404 && !run) {
        return {
          status: "none",
          url: workflowUrl,
          reason: `GitHub shows no ${WORKFLOW} for ${repository}: it has none, or it is private.`,
        };
      } else {
        problem = `GitHub answered ${answer.status}.`;
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
      const failures = await failuresOf(fetch, repository, run);
      return { status: "failed", url, conclusion: run.conclusion, failures };
    }
    const elapsed = clock() - started;
    if (!run && !problem && elapsed >= START_LIMIT_MS) {
      return {
        status: "not-started",
        url: workflowUrl,
        reason: `No ${WORKFLOW} run started for ${commit}.`,
      };
    }
    if (elapsed >= FINISH_LIMIT_MS) {
      return {
        status: "unfinished",
        url: run?.html_url ?? workflowUrl,
        reason: problem ?? "It is still running.",
      };
    }
    await sleep(Math.min(wait, FINISH_LIMIT_MS - elapsed));
  }
}

/** Waits for the Windows check of a commit pushed to `remote`; a remote off GitHub has none. */
async function windowsCheck({ cwd, remote, commit, ...options }) {
  const pushUrl = spawnSync("git", ["-C", cwd, "remote", "get-url", "--push", remote], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (pushUrl.status !== 0) {
    const detail = pushUrl.error?.message ?? pushUrl.stderr.trim();
    throw new Error(`windows check: no push URL for ${remote}: ${detail}`);
  }
  const repository = githubRepository(pushUrl.stdout.trim());
  if (!repository) return { status: "none", reason: `${remote} is not a GitHub repository.` };
  return waitForWindowsCheck({ repository, commit, ...options });
}

const passed = (result) => result.status === "passed" || result.status === "none";

async function main(argv, { cwd = process.cwd(), log = console.log, ...options } = {}) {
  const [commit] = argv;
  if (!commit) {
    console.error("usage: windows-check.cjs <commit>");
    return 2;
  }
  const resolved = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", `${commit}^{commit}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (resolved.status !== 0) throw new Error(`windows check: unknown commit ${commit}`);
  const full = resolved.stdout.trim();
  const result = await windowsCheck({ ...options, cwd, remote: "origin", commit: full });
  log(JSON.stringify({ commit: full, ...result }));
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

module.exports = { NOT_PASSED_EXIT, githubRepository, main, waitForWindowsCheck };
