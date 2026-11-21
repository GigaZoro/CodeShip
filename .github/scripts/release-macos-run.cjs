// The macOS build a Release (fork) run started, from the URL its dispatch step printed: a manual rebuild or the
// catch-up of the same version shares its title. `node .github/scripts/release-macos-run.cjs <owner/repo> <run id>`
// prints one JSON outcome for the run's latest attempt: dispatched (with the run), not-started (the step was skipped),
// pending (an attempt is running) or unverified (anything else, a gh failure included: reported, never guessed).
const { spawnSync } = require("node:child_process");

const PUBLISH_JOB = "Publish GitHub Release";
const DISPATCH_STEP = "Build the macOS app for this release";
const DISPATCH_GROUP = "##[group]Run gh workflow run release-fork-macos.yml ";
// The lines that open the step after the dispatch step: another step, a post step, or the job's end.
const NEXT_STEP = /^(?:##\[group\]|Post job cleanup\.$|Cleaning up orphan processes$)/;
const MACOS_WORKFLOW = "Release (fork) macOS";
const DISPATCH_EVENT = "workflow_dispatch";
const GH_TIMEOUT_MS = 2 * 60 * 1000;

/** The text of each line of `gh run view --job <id> --log`, without its job, step and timestamp columns. */
function logLines(log) {
  return log
    .split(/\r?\n/)
    .map((line) =>
      line.replace(/^[^\t]*\t[^\t]*\t/, "").replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, ""),
    );
}

/**
 * What the dispatch step printed: the version it dispatched and the one run it started, or the problem that keeps
 * them from being known.
 */
function dispatchOutput(log, repository) {
  const lines = logLines(log);
  const starts = lines.flatMap((line, index) => (line.startsWith(DISPATCH_GROUP) ? [index] : []));
  if (starts.length !== 1)
    return { problem: `the job's log has ${starts.length} macOS dispatch steps` };
  const rest = lines.slice(starts[0] + 1);
  const end = rest.findIndex((line) => NEXT_STEP.test(line));
  const step = end === -1 ? rest : rest.slice(0, end);
  const groupEnd = step.indexOf("##[endgroup]");
  if (groupEnd === -1) return { problem: "the dispatch step's log has no end to its command" };
  const versions = step
    .slice(0, groupEnd)
    .flatMap((line) => /^ {2}VERSION: (\S+)$/.exec(line)?.slice(1) ?? []);
  if (versions.length !== 1)
    return { problem: `the dispatch step's log names ${versions.length} versions` };
  const runUrl = new RegExp(
    `^https://github\\.com/${repository.replace(/[.]/g, "\\.")}/actions/runs/(\\d+)$`,
  );
  const runs = step.slice(groupEnd + 1).flatMap((line) => runUrl.exec(line)?.slice(1) ?? []);
  if (runs.length !== 1) return { problem: `the dispatch step printed ${runs.length} run URLs` };
  return { version: versions[0], run: runs[0] };
}

/** The macOS build the release run `runId` started, as one of the outcomes above. `gh` runs gh and returns stdout. */
function releaseMacosRun(repository, runId, gh) {
  const view = (...args) => gh(["run", "view", ...args, "-R", repository]);
  const release = JSON.parse(view(runId, "--json", "status,attempt,url,jobs"));
  const where = `${release.url} (attempt ${release.attempt})`;
  const answer = (outcome, reason) => ({ outcome, reason, release: where });
  if (release.status !== "completed")
    return answer("pending", `the release run is ${release.status}`);
  const jobs = release.jobs.filter((job) => job.name === PUBLISH_JOB);
  if (jobs.length !== 1)
    return answer("unverified", `the release run has ${jobs.length} ${PUBLISH_JOB} jobs`);
  const [job] = jobs;
  if (job.conclusion === "skipped")
    return answer("not-started", `its ${PUBLISH_JOB} job was skipped`);
  const steps = job.steps.filter((step) => step.name === DISPATCH_STEP);
  if (steps.length !== 1)
    return answer(
      "unverified",
      `its ${PUBLISH_JOB} job has ${steps.length} "${DISPATCH_STEP}" steps`,
    );
  const [step] = steps;
  if (step.conclusion === "skipped")
    return answer("not-started", `its "${DISPATCH_STEP}" step was skipped`);
  if (step.status !== "completed")
    return answer("unverified", `its "${DISPATCH_STEP}" step is ${step.status}`);
  const output = dispatchOutput(view("--job", String(job.databaseId), "--log"), repository);
  const ended = step.conclusion === "success" ? "" : ` (the step ended ${step.conclusion})`;
  if (output.problem) return answer("unverified", `${output.problem}${ended}`);
  const macos = JSON.parse(
    view(output.run, "--json", "workflowName,event,displayTitle,createdAt,url"),
  );
  const expected = {
    workflowName: MACOS_WORKFLOW,
    event: DISPATCH_EVENT,
    displayTitle: `${MACOS_WORKFLOW} v${output.version}`,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (macos[field] !== value)
      return answer(
        "unverified",
        `run ${output.run} has ${field} ${JSON.stringify(macos[field])}, not ${JSON.stringify(value)}`,
      );
  }
  // GitHub gives every one of these times in whole seconds, so a run created in the step's last second still counts.
  const created = Date.parse(macos.createdAt);
  if (!(created >= Date.parse(step.startedAt) && created <= Date.parse(step.completedAt))) {
    return answer(
      "unverified",
      `run ${output.run} was created at ${macos.createdAt}, outside the dispatch step (${step.startedAt} to ${step.completedAt})`,
    );
  }
  return {
    outcome: "dispatched",
    run: Number(output.run),
    url: macos.url,
    release: where,
  };
}

function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: GH_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

if (require.main === module) {
  const [repository, runId] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !/^\d+$/.test(runId ?? "")) {
    console.error(
      "usage: node .github/scripts/release-macos-run.cjs <owner/repo> <Release (fork) run id>",
    );
    process.exit(2);
  }
  let result;
  try {
    result = releaseMacosRun(repository, runId, gh);
  } catch (error) {
    result = { outcome: "unverified", reason: error.message, release: `run ${runId}` };
  }
  console.log(JSON.stringify(result));
}

module.exports = { dispatchOutput, releaseMacosRun };
