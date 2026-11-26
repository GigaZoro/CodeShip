// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow files as plain text, like GitHub does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as Schema from "effect/Schema";
import type { AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { describe, expect, it } from "vite-plus/test";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from "yaml";

import { carryMacosFeed, publicConfig } from "../.github/scripts/fork-release.cjs";

const WorkflowJob = Schema.Struct({
  steps: Schema.optional(Schema.Array(Schema.Struct({ run: Schema.optional(Schema.String) }))),
  needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  "runs-on": Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean, Schema.Number])),
  ),
});
type WorkflowJob = typeof WorkflowJob.Type;
const Workflow = Schema.Struct({
  concurrency: Schema.optional(Schema.Struct({ group: Schema.String })),
  jobs: Schema.Record(Schema.String, WorkflowJob),
});
const decodeWorkflow = Schema.decodeUnknownSync(fromYaml(Workflow));
const workflowSource = (file: string) =>
  NodeFS.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
const readWorkflow = (file: string) => decodeWorkflow(workflowSource(file));

const readRepoFile = (path: string) =>
  NodeFS.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const isString = (value: unknown): value is string => typeof value === "string";

/** Every string a YAML value holds, at any depth. */
function stringsIn(value: unknown): ReadonlyArray<string> {
  if (isString(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return typeof value === "object" && value !== null ? Object.values(value).flatMap(stringsIn) : [];
}

const ACTION_AT_COMMIT = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
// GitHub hands workflow_run and pull_request_target runs the base repository's token and secrets.
const PRIVILEGED_TRIGGERS = new Set(["pull_request_target", "workflow_run"]);
const EXPRESSION = /\$\{\{((?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^'"}]|\}(?!\}))*)\}\}/g;
const EXPRESSION_TOKEN = /'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[a-z_][\w-]*|&&|\|\||==|!=|[^\s]/gi;
// Workflows the fork turned off in its Actions settings
// (`gh api repos/GigaZoro/CodeShip/actions/workflows` lists them as disabled_manually).
const DISABLED_IN_FORK = [
  "agent-context-budget.yml",
  "ci.yml",
  "deploy-relay.yml",
  "desktop-macos-preview-publish.yml",
  "desktop-macos-preview.yml",
  "issue-labels.yml",
  "mobile-android-apk.yml",
  "mobile-eas-preview.yml",
  "mobile-eas-production.yml",
  "mobile-fingerprint-check.yml",
  "pr-size.yml",
  "pr-vouch.yml",
  "relay-preview-cleanup.yml",
  "relay-preview.yml",
  "release.yml",
  "stale-needs-more-info.yml",
  "thread-transfer-report.yml",
  "web-preview.yml",
];

const expressionTokens = (expression: string) =>
  expression.toLowerCase().match(EXPRESSION_TOKEN) ?? [];

function readsOtherSecret(expression: string): boolean {
  const tokens = expressionTokens(expression);
  return tokens.some((token, index) => {
    if (token !== "secrets" || tokens[index - 1] === ".") return false;
    const [operator, property, close] = tokens.slice(index + 1, index + 4);
    if (operator === "." && property === "github_token") return false;
    return !(
      operator === "[" &&
      (property === "'github_token'" || property === '"github_token"') &&
      close === "]"
    );
  });
}

function conditionTokens(condition: string) {
  return expressionTokens(condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1"));
}

// An exact repository comparison must be a necessary term of the whole condition.
function upstreamOnly(tokens: ReadonlyArray<string>): boolean {
  const terms: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === "(" || token === "[") depth++;
    if (token === ")" || token === "]") depth--;
    if (depth < 0 || (depth === 0 && (token === "||" || token === "!"))) return false;
    if (depth === 0 && token === "&&") terms.push([]);
    else terms.at(-1)!.push(token);
  }
  if (depth !== 0) return false;
  if (terms.length > 1) return terms.some(upstreamOnly);
  if (tokens[0] === "(" && tokens.at(-1) === ")") return upstreamOnly(tokens.slice(1, -1));
  return tokens.join(" ") === "github . repository == 'pingdotgg/t3code'";
}

/** The reusable workflows a workflow's jobs call and the actions its or a composite action's steps run. */
function usesOf(document: Document) {
  const resolve = (node: unknown) => (isAlias(node) ? node.resolve(document) : node);
  const field = (node: unknown, key: string) => {
    const map = resolve(node);
    return isMap(map) ? map.get(key, true) : undefined;
  };
  const steps = (node: unknown) => {
    const sequence = resolve(field(node, "steps"));
    return isSeq(sequence) ? sequence.items : [];
  };
  const jobsNode = resolve(field(document.contents, "jobs"));
  const jobs = isMap(jobsNode) ? jobsNode.items.map((pair) => pair.value) : [];
  return [...jobs, ...jobs.flatMap(steps), ...steps(field(document.contents, "runs"))].flatMap(
    (owner) => {
      const site = field(owner, "uses");
      const value = resolve(site);
      if ((!isScalar(site) && !isAlias(site)) || !site.range) return [];
      if (!isScalar(value) || !isString(value.value)) return [];
      const map = resolve(owner);
      return [{ ref: value.value, range: site.range, flow: isMap(map) && map.flow }];
    },
  );
}

/**
 * Whether a job that runs in the fork can write to it or reads a secret besides the run's own
 * token: GitHub's default token for this repository is read-only, so only these grant more.
 */
function isPrivileged(document: unknown): boolean {
  const root = asRecord(document);
  const on = root.on;
  const triggers = isString(on) ? [on] : Array.isArray(on) ? on : Object.keys(asRecord(on));
  const grants = (permissions: unknown) =>
    permissions === "write-all" || Object.values(asRecord(permissions)).includes("write");
  const forkTrigger = triggers.some((trigger) => PRIVILEGED_TRIGGERS.has(String(trigger)));
  return Object.values(asRecord(root.jobs))
    .map(asRecord)
    .filter((job) => !(isString(job.if) && upstreamOnly(conditionTokens(job.if))))
    .some(
      (job) =>
        forkTrigger ||
        grants(root.permissions) ||
        grants(job.permissions) ||
        job.secrets === "inherit" ||
        [...stringsIn(root.env), ...stringsIn(job)].some((value) =>
          Array.from(value.matchAll(EXPRESSION), (match) => match[1]!).some(readsOtherSecret),
        ) ||
        [job.if, ...asArray(job.steps).map((step) => asRecord(step).if)]
          .filter(isString)
          .some(readsOtherSecret),
    );
}

/**
 * Every action the workflows run, following local actions and reusable workflows, that is not
 * pinned to a commit on its own `uses:` line with its version in a comment.
 */
function unpinnedActions(roots: ReadonlyArray<string>, read: (path: string) => string) {
  const pending = [...roots];
  const seen = new Set<string>();
  const unpinned: string[] = [];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = read(path);
    const lineCounter = new LineCounter();
    const document = parseDocument(source, { lineCounter });
    if (document.errors.length > 0) throw document.errors[0];
    for (const {
      ref,
      range: [start, end],
      flow,
    } of usesOf(document)) {
      if (ref.startsWith("./.github/workflows/")) pending.push(ref.slice(2));
      else if (ref.startsWith("./")) pending.push(`${ref.slice(2).replace(/\/$/, "")}/action.yml`);
      else {
        const newline = source.indexOf("\n", end);
        const tail = source.slice(end, newline === -1 ? source.length : newline);
        const comment = flow ? /^[ \t]*(?:[},][ \t]*)*#\s*\S/ : /^[ \t]*#\s*\S/;
        if (!ACTION_AT_COMMIT.test(ref) || !comment.test(tail)) {
          unpinned.push(`${path}:${lineCounter.linePos(start).line} ${ref}`);
        }
      }
    }
  }
  return { seen: [...seen], unpinned };
}

/** The workflows GitHub runs in the fork with write access or secrets. */
function privilegedWorkflows() {
  return NodeFS.readdirSync(new URL("../.github/workflows/", import.meta.url))
    .filter((file) => /\.ya?ml$/.test(file) && !DISABLED_IN_FORK.includes(file))
    .filter((file) => isPrivileged(decodeYaml(readRepoFile(`.github/workflows/${file}`))))
    .map((file) => `.github/workflows/${file}`)
    .toSorted();
}

const runnersOf = (job: WorkflowJob) =>
  [job["runs-on"], job.with?.runner, job.with?.verify_runner].filter(
    (runner) => typeof runner === "string",
  );
const isMacosRunner = (runner: string) => runner.includes("macos");

function jobsNeededBy(jobs: Readonly<Record<string, WorkflowJob>>, name: string) {
  const needed = new Set<string>();
  const visit = (job: string) => {
    if (needed.has(job)) return;
    needed.add(job);
    const needs = jobs[job]?.needs ?? [];
    for (const dependency of typeof needs === "string" ? [needs] : needs) visit(dependency);
  };
  visit(name);
  return [...needed];
}

const repository = "/GigaZoro/CodeShip/releases";
const releasedFeed = `version: 2026.1113.14
files:
  - url: T3-Code-2026.1113.14-arm64.zip
    sha512: 5P5qmWw/n2k76/mbfQRjuOSyTuOg104yNiBiaMSWDXhZfpEwo0wPxRNtBwv1D11gkBKyIS2m5H38lnH8HRd0IA==
    size: 183206303
  - url: T3-Code-2026.1113.14-arm64.dmg
    sha512: 7VBtAT9DHFq9DAsylJJNWRS+KV1ChW+tXztG/esWzJLn76h9JfFMSM8XLnMklifLj95OdlqfUIOzFaZk3Flw/w==
    size: 190189736
path: T3-Code-2026.1113.14-arm64.zip
sha512: 5P5qmWw/n2k76/mbfQRjuOSyTuOg104yNiBiaMSWDXhZfpEwo0wPxRNtBwv1D11gkBKyIS2m5H38lnH8HRd0IA==
releaseDate: '2026-11-13T21:14:35.428Z'
`;
const macAssets = ["T3-Code-2026.1113.14-arm64.zip", "T3-Code-2026.1113.14-arm64.dmg"];

/** Serves a GitHub repository's releases, newest first, as github.com does. */
class GitHubReleases extends ElectronHttpExecutor {
  readonly files = new Map<string, string>();

  constructor(
    releases: ReadonlyArray<{ readonly tag: string; readonly assets: Record<string, string> }>,
  ) {
    super();
    const entries = releases.map(
      ({ tag }) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com${repository}/tag/${tag}"/><title>${tag}</title><content>Notes</content></entry>`,
    );
    this.files.set(
      `${repository}.atom`,
      `<feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`,
    );
    this.files.set(`${repository}/latest`, JSON.stringify({ tag_name: releases[0]?.tag }));
    for (const { tag, assets } of releases) {
      for (const [name, body] of Object.entries(assets)) {
        this.files.set(`${repository}/download/${tag}/${name}`, body);
      }
    }
  }

  override request(
    options: Parameters<ElectronHttpExecutor["request"]>[0],
  ): Promise<string | null> {
    const body = this.files.get(String(options.path));
    return body === undefined
      ? Promise.reject(new Error(`404 Not Found: ${options.path}`))
      : Promise.resolve(body);
  }
}

/** What a stable Mac build of the app sees when it checks for updates. */
const checkFromMac = async (releases: GitHubReleases) => {
  const updater = { allowPrerelease: false, channel: "latest", fullChangelog: false };
  const provider = new GitHubProvider(
    { provider: "github", owner: "GigaZoro", repo: "CodeShip" },
    updater satisfies Partial<AppUpdater> as AppUpdater,
    { isUseMultipleRangeRequest: false, platform: "darwin", executor: releases },
  );
  const update = await provider.getLatestVersion();
  return {
    version: update.version,
    downloads: provider.resolveFiles(update).map(({ url }) => url),
  };
};

describe("fork release", () => {
  it("publishes Windows and Linux without waiting for a macOS runner", () => {
    const release = readWorkflow("release-fork.yml");
    const publishedAfter = jobsNeededBy(release.jobs, "release");
    expect(publishedAfter).toContain("desktop_win_x64");
    for (const job of publishedAfter) {
      expect(runnersOf(release.jobs[job]!).filter(isMacosRunner), job).toEqual([]);
    }

    const macos = readWorkflow("release-fork-macos.yml");
    expect(Object.values(macos.jobs).flatMap(runnersOf).some(isMacosRunner)).toBe(true);
    // A shared group would hold the next release behind a macOS run waiting for a runner.
    expect(macos.concurrency?.group).not.toBe(release.concurrency?.group);
  });

  it("stages the native metadata package built for each released server", () => {
    const release = readWorkflow("release-fork.yml");
    const mac = readWorkflow("release-fork-macos.yml");
    for (const [workflow, packager, builder, target] of [
      [release, "desktop_linux_x64", "metadata_linux", "x86_64-unknown-linux-musl"],
      [release, "desktop_win_x64", "metadata_windows", "x86_64-pc-windows-msvc"],
      [mac, "desktop_mac_arm64", "metadata_mac", "aarch64-apple-darwin"],
    ] as const) {
      expect(jobsNeededBy(workflow.jobs, packager)).toContain(builder);
      expect(workflow.jobs[builder]?.with?.target).toBe(target);
      expect(workflow.jobs[packager]?.with?.codex_metadata_key).toBe(
        `\${{ needs.${builder}.outputs.cache_key }}`,
      );
    }
  });

  it("builds the Linux metadata runtime where musl links working static binaries", () => {
    // Ubuntu 22.04's musl 1.2.2 links Rust 1.99 binaries that crash on start; 24.04's musl
    // 1.2.4 works. The build's own musl check stops an older musl before cargo runs.
    const release = readWorkflow("release-fork.yml");
    expect(release.jobs.metadata_linux?.with?.runner).toBe("ubuntu-24.04");
  });

  it("treats only a run on the default branch as main's release run", () => {
    const release = readWorkflow("release-fork.yml");
    expect(release.concurrency?.group).toContain("github.ref");

    const retry = workflowSource("release-fork-retry.yml");
    expect(retry).toContain(
      "github.event.workflow_run.head_branch == github.event.repository.default_branch",
    );
    const listings = retry.match(/gh run list[^\n]*\\\n[^\n]*/g) ?? [];
    expect(listings).toHaveLength(1);
    for (const listing of listings.filter((line) => line.includes("release-fork.yml"))) {
      expect(listing).toContain('--branch "$DEFAULT_BRANCH"');
    }
    expect(retry).toContain("activity?ref=refs/heads/$DEFAULT_BRANCH");
  });

  // A job that can write to the fork or holds its secrets runs only action code someone read:
  // a tag or branch can be moved to other code after the review.
  it("pins every action a privileged workflow runs to a commit", () => {
    const roots = privilegedWorkflows();
    expect(roots).toEqual(
      expect.arrayContaining([
        ".github/workflows/mobile-eas-preview-fork.yml",
        ".github/workflows/mobile-fingerprint-label.yml",
        ".github/workflows/release-fork-macos.yml",
        ".github/workflows/release-fork-retry.yml",
        ".github/workflows/release-fork.yml",
      ]),
    );
    const pinned = unpinnedActions(roots, readRepoFile);
    expect(pinned.seen).toEqual(
      expect.arrayContaining([
        ".github/workflows/release-codex-metadata.yml",
        ".github/workflows/release-desktop.yml",
        ".github/actions/setup-ci-deps/action.yml",
      ]),
    );
    expect(pinned.unpinned).toEqual([]);
    for (const file of DISABLED_IN_FORK) {
      expect(
        NodeFS.existsSync(new URL(`../.github/workflows/${file}`, import.meta.url)),
        file,
      ).toBe(true);
    }
  });

  it("finds privilege and unpinned actions from the workflow's structure", () => {
    const workflow = (on: string, job: string) => `on: ${on}\njobs:\n  a:\n${job}`;
    const job = "    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n";
    expect(isPrivileged(decodeYaml(workflow("push", job)))).toBe(false);
    expect(isPrivileged(decodeYaml(workflow("[push, workflow_run]", job)))).toBe(true);
    expect(isPrivileged(decodeYaml(`permissions: write-all\n${workflow("push", job)}`))).toBe(true);
    expect(isPrivileged(decodeYaml(`permissions: read-all\n${workflow("push", job)}`))).toBe(false);
    const writes = "    permissions:\n      id-token: write\n";
    expect(isPrivileged(decodeYaml(workflow("push", `${writes}${job}`)))).toBe(true);
    const token = "    env:\n      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n";
    expect(isPrivileged(decodeYaml(workflow("push", `${token}${job}`)))).toBe(false);
    const secret = "    env:\n      KEY: ${{ secrets.SIGNING_KEY }}\n";
    expect(isPrivileged(decodeYaml(workflow("push", `${secret}${job}`)))).toBe(true);
    const upstreamOnly = "    if: github.repository == 'pingdotgg/t3code'\n";
    expect(isPrivileged(decodeYaml(workflow("push", `${upstreamOnly}${secret}${job}`)))).toBe(
      false,
    );
    const orElsewhere = "    if: github.repository == 'pingdotgg/t3code' || inputs.force\n";
    expect(isPrivileged(decodeYaml(workflow("push", `${orElsewhere}${secret}${job}`)))).toBe(true);

    const fixture = [
      "jobs:",
      "  call:",
      "    uses: owner/repo/.github/workflows/w.yml@main",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v6",
      "      - uses: softprops/action-gh-release@8a0cd651e5b2365bd640854a3fa5dfc70e4875f3",
      "      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6",
      "      - { uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 }",
      "      # - uses: actions/checkout@main",
    ].join("\n");
    expect(unpinnedActions(["w.yml"], () => fixture).unpinned).toEqual([
      "w.yml:3 owner/repo/.github/workflows/w.yml@main",
      "w.yml:6 actions/checkout@v6",
      "w.yml:7 softprops/action-gh-release@8a0cd651e5b2365bd640854a3fa5dfc70e4875f3",
      "w.yml:9 actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    ]);
  });

  it.each([
    ["secrets['SIGNING_KEY']", true],
    ['secrets["SIGNING_KEY"]', true],
    ["toJSON(secrets)", true],
    ["secrets[inputs.key]", true],
    ["format('text with }}', SECRETS.SIGNING_KEY)", true],
    ["secrets['GITHUB_TOKEN']", false],
    ["inputs.secrets", false],
    ["'secrets.SIGNING_KEY'", false],
  ])("recognizes the secrets context in %s", (expression, privileged) => {
    const workflow = decodeYaml(
      ["on: push", "jobs:", "  build:", "    env:", `      KEY: \${{ ${expression} }}`].join("\n"),
    );
    expect(isPrivileged(workflow)).toBe(privileged);
  });

  it.each([
    ["github.repository == 'pingdotgg/t3code' && inputs.release || inputs.force", true],
    ["!(github.repository == 'pingdotgg/t3code')", true],
    ["(github.repository == 'pingdotgg/t3code' && inputs.release) || inputs.force", true],
    ["github.repository == 'pingdotgg/t3code' && (inputs.release || inputs.force)", false],
    ["inputs.release && (github.repository == 'pingdotgg/t3code')", false],
  ])("uses the whole job condition %s to determine privilege", (condition, privileged) => {
    const workflow = decodeYaml(
      ["permissions: write-all", "jobs:", "  build:", `    if: \${{ ${condition} }}`].join("\n"),
    );
    expect(isPrivileged(workflow)).toBe(privileged);
  });

  it("requires a version comment for each uses scalar including flow steps", () => {
    const ref = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
    const workflow = [
      "jobs:",
      "  build:",
      "    steps:",
      `      # - uses: ${ref} # v6.1.0`,
      `      - uses: ${ref} # v6.1.0`,
      `      - { uses: ${ref} }`,
      `      - { uses: '${ref}' } # v6.1.0`,
    ].join("\n");
    expect(unpinnedActions(["w.yml"], () => workflow).unpinned).toEqual([`w.yml:6 ${ref}`]);
  });

  it("dispatches both macOS builds against the published tag after the default branch advances", () => {
    for (const [file, tag] of [
      ["release-fork.yml", "v$VERSION"],
      ["release-fork-retry.yml", "$tag"],
    ] as const) {
      const commands = workflowSource(file)
        .split("\n")
        .filter((line) => line.includes("gh workflow run release-fork-macos.yml "));
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain(`--ref "${tag}"`);
    }
    expect(workflowSource("release-fork-macos.yml")).toContain('"$GITHUB_SHA" != "$sha"');
    expect(workflowSource("release-fork-retry.yml")).toContain('"$RUN_SHA" != "$sha"');
  });

  it("recovers a Mac build only from a dispatch on its published tag", () => {
    const retry = workflowSource("release-fork-retry.yml");
    const preflight = workflowSource("release-fork-macos.yml");
    expect(workflowSource("release-fork.yml")).toContain("<!-- codeship-publisher-run: %s -->");
    expect(preflight).toContain("run-id: ${{ steps.bundle.outputs.run_id }}");
    expect(preflight).not.toContain("${{ inputs.bundle_run }}");
    expect(retry).toContain('recover-macos "$tag" "$sha" "$published"');
    expect(preflight).toContain(
      "name: Download JS bundle from publisher ${{ steps.bundle.outputs.run_id }}",
    );
    expect(workflowSource("release-fork-macos.yml")).toMatch(/^run-name:.*github\.ref_type/m);
  });

  describe.skipIf(isWindowsHost)("Mac release recovery", () => {
    const tag = "v2026.1124.7";
    const title = "Release (fork) macOS " + tag;
    const script = readWorkflow("release-fork-retry.yml").jobs["catch-up-macos"]!.steps!.find(
      (step) => step.run?.includes("releases/latest"),
    )!.run!;
    const stubs = `
gh() {
  case "$1 $2" in
    "api repos/fixture/repo/releases/latest") echo "v2026.1124.7 abcd 2026-01-01T00:00:00Z false" ;;
    "run rerun"|"workflow run") echo "WRITE $*" ;;
    *) return 64 ;;
  esac
}
node() {
  [[ "$*" == ".github/scripts/fork-release.cjs recover-macos v2026.1124.7 abcd 2026-01-01T00:00:00Z" ]] || return 65
  [[ "$PLAN" != error ]] || return 1
  echo "$PLAN"
}
`;
    const run = (env: Record<string, string> = {}) =>
      NodeChildProcess.spawnSync("bash", ["-c", stubs + script], {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
          GITHUB_REPOSITORY: "fixture/repo",
          GITHUB_EVENT_NAME: "workflow_run",
          RUN_TITLE: title,
          RUN_SHA: "abcd",
          RUN_ID: "502",
          PLAN: "wait",
          MAX_ATTEMPTS: "24",
          IMMEDIATE_ATTEMPTS: "3",
          ...env,
        },
      });
    const writes = (env: Record<string, string>) => {
      const result = run(env);
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.split("\n").filter((line) => line.startsWith("WRITE "));
    };

    it("acts only on the validated tag and publisher plan on either trigger", () => {
      for (const trigger of ["workflow_run", "schedule"]) {
        expect(writes({ GITHUB_EVENT_NAME: trigger, PLAN: "dispatch 480" })).toEqual([
          `WRITE workflow run release-fork-macos.yml --repo fixture/repo --ref ${tag} -f version=2026.1124.7 -f bundle_run=480`,
        ]);
        expect(writes({ GITHUB_EVENT_NAME: trigger, PLAN: "rerun 502" })).toEqual([
          "WRITE run rerun 502 --failed --repo fixture/repo",
        ]);
        expect(writes({ GITHUB_EVENT_NAME: trigger, PLAN: "wait" })).toEqual([]);
      }
      const unavailable = run({ PLAN: "error" });
      expect(unavailable.status).not.toBe(0);
      expect(unavailable.stdout).not.toContain("WRITE ");
    });
    it("ignores failure of another release at the same SHA", () => {
      expect(
        writes({
          RUN_TITLE: "Release (fork) macOS v2026.1124.6 (branch dispatch)",
          PLAN: "dispatch 480",
        }),
      ).toEqual([]);
      expect(writes({ RUN_SHA: "older", PLAN: "dispatch 480" })).toEqual([]);
    });
  });

  it("populates the Mac package cache on main using the release tag's native recipe", () => {
    const producerFile = "cache-fork-codex-macos.yml";
    const producer = readWorkflow(producerFile);
    const tag = readWorkflow("release-fork-macos.yml");
    const warm = producer.jobs.metadata_mac!;
    const tagged = tag.jobs.metadata_mac!;
    expect(workflowSource(producerFile)).toContain("push:\n    branches: [main]");
    expect(warm.uses).toBe(tagged.uses);
    expect(warm.with).toEqual({ ...tagged.with, ref: "${{ github.sha }}" });
    expect(producer.concurrency?.group).not.toBe(
      readWorkflow("release-fork.yml").concurrency?.group,
    );
    expect(producer.concurrency?.group).not.toBe(tag.concurrency?.group);
  });

  it("serves Macs the previous build until the macOS app is attached", async () => {
    const previous = {
      tag: "v2026.1113.14",
      assets: {
        "latest-mac.yml": releasedFeed,
        ...Object.fromEntries(macAssets.map((name) => [name, name])),
      },
    };

    await expect(
      checkFromMac(new GitHubReleases([{ tag: "v2026.1113.15", assets: {} }, previous])),
    ).rejects.toThrow("latest-mac.yml");

    const carried = carryMacosFeed(releasedFeed, "v2026.1113.14");
    const newer = { tag: "v2026.1113.15", assets: { "latest-mac.yml": carried } };
    // The release after it carries the carried feed again before its own app lands.
    const newest = {
      tag: "v2026.1113.16",
      assets: { "latest-mac.yml": carryMacosFeed(carried, "v2026.1113.15") },
    };
    for (const releases of [
      [newer, previous],
      [newest, newer, previous],
    ]) {
      const server = new GitHubReleases(releases);
      const update = await checkFromMac(server);
      expect(update.version).toBe("2026.1113.14");
      expect(update.downloads.map((url) => url.pathname)).toEqual(
        macAssets.map((name) => `${repository}/download/v2026.1113.14/${name}`),
      );
      for (const url of update.downloads) expect(server.files.has(url.pathname)).toBe(true);
    }
  });

  it("reads only plain public T3 Connect values", () => {
    expect(publicConfig("T3CODE_RELAY_URL=wss://relay.example.com/ws\n")).toContain(
      "relay_url=wss://relay.example.com/ws",
    );
    expect(() => publicConfig("T3CODE_RELAY_URL=$(curl evil)\n")).toThrow(
      "T3CODE_RELAY_URL is malformed",
    );
  });
});
