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
