// A push to main runs check:changed on Windows (.github/workflows/windows-check-fork.yml), the one place a change landed
// from macOS or Linux meets Windows. A red run there reaches no one unless the lander waits for it, so after landing the
// ship skill and the upstream sync run `node .github/scripts/windows-check.cjs <commit>`: it waits for that commit's run
// and prints its result, exiting 0 when it passed or the commit has no Windows check, 3 otherwise.
const { spawnSync } = require("node:child_process");
const { GIT_CALL_LIMITS, GIT_OUTPUT_MAX_BYTES, REAL_HISTORY_ENV } = require("./git-history.cjs");

const WORKFLOW = "windows-check-fork.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
const API = "https://api.github.com";
// Without a token GitHub allows 60 requests an hour per address, which every lander on the machine shares.
const POLL_MS = 3 * 60 * 1000;
// GitHub creates a push's run within seconds, even while it waits for a runner.
const START_LIMIT_MS = 15 * 60 * 1000;
// The job may run for the workflow's 360 minutes after it waits for a runner.
const FINISH_LIMIT_MS = 400 * 60 * 1000;
// Room to read a run that ends at the finish limit, and its failures; callers allow 420 minutes in all.
const REPORT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
// GitHub asks a client it refuses to wait at least a minute when it names no time, and longer after each refusal.
const RETRY_MS = 60 * 1000;
const MAX_FAILURES = 20;
const NOT_PASSED_EXIT = 3;

/** The GitHub owner and repository a remote URL points at, or null for any other host. */
function githubRepository(url) {
  const scp = /^(?:[^@/:]+@)?(?:ssh\.)?github\.com:\/?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (scp) return `${scp[1]}/${scp[2]}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase();
  // GitHub serves SSH on port 443 at ssh.github.com for networks that block port 22.
  if (host !== "github.com" && !(host === "ssh.github.com" && parsed.protocol === "ssh:")) {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * How long GitHub asks this address to wait before its next request, the longer of its two limits; `now` is the wall
 * clock its reset time is on.
 */
function backoffMs(headers, now) {
  const retryAfter = Number(headers.get("retry-after")) * 1000 || 0;
  const reset = Number(headers.get("x-ratelimit-reset"));
  const untilReset =
    headers.get("x-ratelimit-remaining") === "0" && reset > 0 ? reset * 1000 - now() : 0;
  return Math.max(0, retryAfter, untilReset);
}

// A secondary rate limit can refuse with a 403 that only its message tells from a denied request.
const refusedForRateLimit = ({ status, headers }, text) =>
  status === 429 ||
  (status === 403 &&
    (headers.has("retry-after") ||
      headers.get("x-ratelimit-remaining") === "0" ||
      /rate limit/i.test(text)));

/**
 * GitHub's API as one address sees it: each request first waits until GitHub allows it, on the monotonic `clock`, and
 * one GitHub refuses for its rate limit is sent again then. Resolves to null when GitHub allows none before `deadline`.
 */
function githubApi({ fetch, sleep, clock, now, deadline }) {
  let notBefore = -Infinity;
  let refusals = 0;
  return async (path) => {
    for (;;) {
      if (notBefore > deadline) return null;
      const wait = notBefore - clock();
      if (wait > 0) await sleep(wait);
      // A wait can end late, as on a machine that slept.
      const left = deadline - clock();
      if (left <= 0) return null;
      const response = await fetch(`${API}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "t3-landing-turn",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left)),
      });
      const text = response.ok ? "" : await response.text();
      const refused = refusedForRateLimit(response, text);
      refusals = refused ? refusals + 1 : 0;
      const backoff = backoffMs(response.headers, now);
      notBefore = clock() + (refused ? Math.max(backoff, RETRY_MS * 2 ** (refusals - 1)) : backoff);
      if (response.ok) return { status: response.status, body: await response.json() };
      if (!refused) return { status: response.status, body: null };
    }
  };
}

const OUT_OF_REQUESTS = "GitHub allows this address no more requests before the time limit.";

async function failuresOf(get, repository, run) {
  const failures = [];
  const read = async (path, what) => {
    try {
      const answer = await get(path);
      if (answer?.body) return answer.body;
      failures.push(
        answer ? `GitHub answered ${answer.status} for ${what}.` : `${OUT_OF_REQUESTS} (${what})`,
      );
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
 * Waits for the Windows check of `commit` (a full SHA whose tree has the workflow) on `repository` ("owner/name").
 * `unreadable` means GitHub does not show the workflow, never that it passed. Waits on the monotonic `clock`; `now` is
 * the wall clock, read only against GitHub's rate-limit reset time.
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
  const get = githubApi({
    fetch,
    sleep,
    clock,
    now,
    deadline: started + FINISH_LIMIT_MS + REPORT_MS,
  });
  const workflowUrl = `https://github.com/${repository}/actions/workflows/${WORKFLOW}`;
  const listing = `/repos/${repository}/actions/workflows/${WORKFLOW}/runs?head_sha=${commit}&event=push&per_page=1`;
  let run = null;
  let problem = null;
  for (;;) {
    try {
      const answer = await get(run ? `/repos/${repository}/actions/runs/${run.id}` : listing);
      if (!answer) {
        return { status: "unfinished", url: run?.html_url ?? workflowUrl, reason: OUT_OF_REQUESTS };
      }
      if (answer.body) {
        run = run ? answer.body : (answer.body.workflow_runs[0] ?? null);
        problem = null;
      } else if (answer.status === 404 && !run) {
        // GitHub answers 404 for a private repository to a request without a token.
        return {
          status: "unreadable",
          url: workflowUrl,
          reason: `GitHub shows no ${WORKFLOW} for ${repository}, though the commit has it: the repository is private, or GitHub does not know the workflow.`,
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
        return {
          status: "none",
          url,
          reason: "GitHub skips the Windows check in this repository.",
        };
      }
      const failures = await failuresOf(get, repository, run);
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
    await sleep(Math.min(POLL_MS, FINISH_LIMIT_MS - elapsed));
  }
}

// GitHub runs the pushed commit, which a replace ref or graft in this checkout can hide.
const git = (cwd, ...args) =>
  spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...REAL_HISTORY_ENV },
    maxBuffer: GIT_OUTPUT_MAX_BYTES,
    ...GIT_CALL_LIMITS,
    windowsHide: true,
  });
const failureOf = (result) => result.error?.message ?? result.stderr.trim();

/**
 * Waits for the Windows check of `commit` pushed to `remote`. A commit without the workflow, or a push off GitHub, has
 * none.
 */
async function windowsCheck({ cwd, remote, commit, ...options }) {
  const workflow = git(cwd, "ls-tree", "--full-tree", "--name-only", commit, "--", WORKFLOW_PATH);
  if (workflow.status !== 0) throw new Error(`cannot read ${commit}: ${failureOf(workflow)}`);
  if (workflow.stdout.trim() === "") {
    return { status: "none", url: null, reason: `The commit has no ${WORKFLOW_PATH}.` };
  }
  const pushUrls = git(cwd, "remote", "get-url", "--push", "--all", remote);
  if (pushUrls.status !== 0) throw new Error(`no push URL for ${remote}: ${failureOf(pushUrls)}`);
  // GitHub's owner and repository names ignore case.
  const repositories = [
    ...new Set(
      pushUrls.stdout.split("\n").map((url) => githubRepository(url.trim())?.toLowerCase()),
    ),
  ].filter(Boolean);
  if (repositories.length === 0) {
    return { status: "none", url: null, reason: `${remote} does not push to GitHub.` };
  }
  if (repositories.length > 1) {
    throw new Error(
      `${remote} pushes to several GitHub repositories (${repositories.join(", ")}), so the commit has a Windows check in each.`,
    );
  }
  return waitForWindowsCheck({ ...options, repository: repositories[0], commit });
}

const passed = (result) => result.status === "passed" || result.status === "none";

async function main(argv, { cwd = process.cwd(), log = console.log, ...options } = {}) {
  const [commit] = argv;
  if (argv.length !== 1 || !commit || commit.startsWith("-")) {
    console.error("usage: windows-check.cjs <commit>");
    return 2;
  }
  let full = commit;
  let result;
  // Callers read the result line, so a check that cannot run reports there too.
  try {
    const resolved = git(cwd, "rev-parse", "--verify", `${commit}^{commit}`);
    if (resolved.status !== 0) throw new Error(`unknown commit ${commit}`);
    full = resolved.stdout.trim();
    result = await windowsCheck({ ...options, cwd, remote: "origin", commit: full });
  } catch (error) {
    result = { status: "unreadable", url: null, reason: error.message };
  }
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

module.exports = { githubRepository, main, waitForWindowsCheck };
