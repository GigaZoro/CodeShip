// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow files as plain text, like GitHub does, and runs their shell steps.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
  needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  "runs-on": Schema.optional(Schema.String),
  steps: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.optional(Schema.String), run: Schema.optional(Schema.String) }),
    ),
  ),
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
const readWorkflow = (file: string) =>
  decodeWorkflow(
    NodeFS.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"),
  );

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

  it("treats only a run on the default branch as main's release run", () => {
    const release = readWorkflow("release-fork.yml");
    expect(release.concurrency?.group).toContain("github.ref");

    const retry = NodeFS.readFileSync(
      new URL("../.github/workflows/release-fork-retry.yml", import.meta.url),
      "utf8",
    );
    expect(retry).toContain(
      "github.event.workflow_run.head_branch == github.event.repository.default_branch",
    );
    expect(retry).toContain("github.event.workflow_run.name == 'Release (fork) macOS' ||");
    const mainListings =
      retry.match(/gh run list[^\n]*--workflow release-fork\.yml[^\n]*\\\n[^\n]*/g) ?? [];
    expect(mainListings).toHaveLength(1);
    expect(mainListings[0]).toContain('--branch "$DEFAULT_BRANCH"');
    expect(retry).toContain("activity?ref=refs/heads/$DEFAULT_BRANCH");
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

  it("starts the macOS build at the release's tag", () => {
    const dispatches = [
      ".github/workflows/release-fork.yml",
      ".github/workflows/release-fork-retry.yml",
    ]
      .flatMap((file) => stringsIn(decodeYaml(readRepoFile(file))))
      .flatMap((script) => script.match(/gh workflow run release-fork-macos\.yml[^\n]*/g) ?? []);
    expect(dispatches.length).toBe(2);
    for (const dispatch of dispatches) expect(dispatch).toMatch(/--ref "(?:v\$VERSION|\$tag)"/);
  });

  it.skipIf(isWindowsHost)(
    "catches up macOS using the publishing run recorded on the release",
    () => {
      const script = readWorkflow("release-fork-retry.yml").jobs["catch-up-macos"]?.steps?.[0]?.run;
      if (script === undefined) throw new Error("Missing the macOS catch-up step.");
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-macos-catch-up-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(dir, "gh"),
          [
            "#!/usr/bin/env bash",
            'case "$1 $2" in',
            '  "api "*/releases/*) jq -r "$4" <<<"$RELEASE" ;;',
            '  "run list") [[ "$6" == release-fork-macos.yml ]] && jq -r "${12}" <<<"$RUNS" ;;',
            '  "workflow run") printf "%s\\n" "${@:3}" ;;',
            "  *) exit 2 ;;",
            "esac",
          ].join("\n"),
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(dir, "date"),
          '#!/usr/bin/env bash\nif [[ "$1" == -d ]]; then echo 0; else echo 1000; fi\n',
          { mode: 0o755 },
        );
        const runStep = (body: string, runRef = "main") =>
          NodeChildProcess.spawnSync("bash", ["-c", script], {
            encoding: "utf8",
            env: {
              PATH: `${dir}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              GITHUB_REPOSITORY: "GigaZoro/CodeShip",
              RUNS: JSON.stringify([
                {
                  databaseId: 9,
                  displayTitle: "Release (fork) macOS v2026.1121.3",
                  headBranch: runRef,
                  status: "in_progress",
                  attempt: 1,
                  conclusion: "",
                },
              ]),
              RELEASE: JSON.stringify({
                tag_name: "v2026.1121.3",
                target_commitish: "a".repeat(40),
                published_at: "2026-11-21T12:30:00Z",
                assets: [],
                body,
              }),
            },
          });
        const body = `Notes\r\n\r\n<!-- codeship-bundle 42 101 ${"a".repeat(64)} -->\r\n`;
        const recorded = runStep(body);
        expect(recorded.status, recorded.stderr).toBe(0);
        expect(recorded.stdout).toContain(
          "--ref\nv2026.1121.3\n-f\nversion=2026.1121.3\n-f\nbundle_run=42",
        );
        const existing = runStep(body, "v2026.1121.3");
        expect(existing.status, existing.stderr).toBe(0);
        expect(existing.stdout).toBe("Run 9 for v2026.1121.3 is in_progress.\n");
        const legacy = runStep("Notes");
        expect(legacy.status).toBe(1);
        expect(legacy.stdout).toContain("has no recorded JS bundle");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // The step runs on ubuntu-24.04 runners; Windows has no bash to run it with.
  it.skipIf(isWindowsHost)(
    "accepts only the release's exact tag, producer, artifact digest and bundle version",
    () => {
      const script = readWorkflow("release-fork-macos.yml").jobs.preflight?.steps?.find(
        (step) => step.id === "release",
      )?.run;
      const recordBundle = readWorkflow("release-fork.yml").jobs.release?.steps?.find(
        (step) => step.id === "provenance",
      )?.run;
      if (script === undefined)
        throw new Error("release-fork-macos.yml has no preflight step `release`.");
      if (recordBundle === undefined) throw new Error("release-fork.yml has no `provenance` step.");
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-macos-release-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(dir, "gh"),
          [
            "#!/usr/bin/env bash",
            'case "$2" in',
            '  */releases/tags/*) if [[ "$3" == --jq ]]; then jq -r "$4" <<<"$RELEASE"; else echo "$RELEASE"; fi ;;',
            '  */commits/*) echo "$TAG_SHA" ;;',
            '  */actions/artifacts/101/zip) cat "$BUNDLE_ZIP" ;;',
            '  */actions/artifacts/101) printf "%s\\n" "$ARTIFACT" | jq -r "$4" ;;',
            "  *) exit 2 ;;",
            "esac",
          ].join("\n"),
          { mode: 0o755 },
        );
        const sha = "a".repeat(40);
        const zipBundle = (version: string) => {
          const archive = NodePath.join(dir, `${version}.zip`);
          NodeFS.writeFileSync(NodePath.join(dir, "bundle-version.txt"), `${version}\n`);
          NodeChildProcess.execFileSync("zip", ["-q", archive, "bundle-version.txt"], { cwd: dir });
          return {
            archive,
            digest: NodeCrypto.createHash("sha256")
              .update(NodeFS.readFileSync(archive))
              .digest("hex"),
          };
        };
        const bundle = zipBundle("2026.1121.3");
        const otherBundle = zipBundle("2026.1121.4");
        const releaseBody = (digest: string) => {
          const notes = NodePath.join(dir, "release-notes.md");
          NodeFS.writeFileSync(notes, "Notes\n");
          NodeChildProcess.execFileSync("bash", ["-c", recordBundle], {
            cwd: dir,
            env: {
              ...process.env,
              GITHUB_RUN_ID: "42",
              GITHUB_OUTPUT: NodePath.join(dir, "producer-output"),
              ARTIFACT_ID: "101",
              ARTIFACT_DIGEST: digest,
            },
          });
          return NodeFS.readFileSync(notes, "utf8");
        };
        const body = releaseBody(bundle.digest).replaceAll("\n", "\r\n");
        const artifact = (digest: string, run = 42, headSha = sha) =>
          JSON.stringify({
            id: 101,
            name: "js-bundle",
            expired: false,
            digest: `sha256:${digest}`,
            workflow_run: { id: run, head_sha: headSha },
          });
        const runStep = (env: Record<string, string>) => {
          const output = NodePath.join(dir, "output");
          NodeFS.rmSync(NodePath.join(dir, "js-bundle"), { recursive: true, force: true });
          NodeFS.writeFileSync(output, "");
          const result = NodeChildProcess.spawnSync("bash", ["-c", script], {
            encoding: "utf8",
            cwd: dir,
            env: {
              PATH: `${dir}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              GITHUB_REPOSITORY: "GigaZoro/CodeShip",
              GITHUB_OUTPUT: output,
              VERSION: "2026.1121.3",
              BUNDLE_RUN: "42",
              GITHUB_REF: "refs/tags/v2026.1121.3",
              GITHUB_SHA: sha,
              TAG_SHA: sha,
              RUNNER_TEMP: dir,
              RELEASE: JSON.stringify({
                target_commitish: sha,
                body,
              }),
              ARTIFACT: artifact(bundle.digest),
              BUNDLE_ZIP: bundle.archive,
              ...env,
            },
          });
          const diagnostic = [result.stdout, result.stderr, result.error?.message].join("\n");
          return { diagnostic, status: result.status, output: NodeFS.readFileSync(output, "utf8") };
        };
        const accepted = runStep({});
        expect(accepted, accepted.diagnostic).toMatchObject({ status: 0, output: `sha=${sha}\n` });
        const other = "b".repeat(40);
        for (const change of [
          { GITHUB_REF: "refs/heads/main" },
          { GITHUB_SHA: other },
          { TAG_SHA: other },
          { ARTIFACT: artifact(bundle.digest, 42, other) },
          { BUNDLE_RUN: "43" },
          { RELEASE: JSON.stringify({ target_commitish: sha, body: "Notes" }) },
          { ARTIFACT: artifact(bundle.digest, 43) },
          { ARTIFACT: artifact(otherBundle.digest) },
          { BUNDLE_ZIP: otherBundle.archive },
          {
            RELEASE: JSON.stringify({
              target_commitish: sha,
              body: releaseBody(otherBundle.digest),
            }),
            ARTIFACT: artifact(otherBundle.digest),
            BUNDLE_ZIP: otherBundle.archive,
          },
        ]) {
          const rejected = runStep(change);
          expect(rejected, `${JSON.stringify(change)}\n${rejected.diagnostic}`).toMatchObject({
            status: 1,
            output: "",
          });
        }
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("reads only plain public T3 Connect values", () => {
    expect(publicConfig("T3CODE_RELAY_URL=wss://relay.example.com/ws\n")).toContain(
      "relay_url=wss://relay.example.com/ws",
    );
    expect(() => publicConfig("T3CODE_RELAY_URL=$(curl evil)\n")).toThrow(
      "T3CODE_RELAY_URL is malformed",
    );
  });
});
