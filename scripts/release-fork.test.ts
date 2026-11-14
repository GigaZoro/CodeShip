// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow files as plain text, like GitHub does.
import * as NodeFS from "node:fs";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import type { AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { describe, expect, it } from "vite-plus/test";

import { carryMacosFeed, publicConfig } from "../.github/scripts/fork-release.cjs";

const WorkflowJob = Schema.Struct({
  needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  "runs-on": Schema.optional(Schema.String),
  with: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean, Schema.Number])),
  ),
});
type WorkflowJob = typeof WorkflowJob.Type;
const Workflow = Schema.Struct({
  concurrency: Schema.Struct({ group: Schema.String }),
  jobs: Schema.Record(Schema.String, WorkflowJob),
});
const decodeWorkflow = Schema.decodeUnknownSync(fromYaml(Workflow));
const readWorkflow = (file: string) =>
  decodeWorkflow(
    NodeFS.readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"),
  );

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
    expect(macos.concurrency.group).not.toBe(release.concurrency.group);
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
