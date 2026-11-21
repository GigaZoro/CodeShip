// @effect-diagnostics nodeBuiltinImport:off - Runs the repository's command-line scripts as child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const UNREAD = "--no-such-argument";

/**
 * A command line of each script that reads its own, with an argument the script does not take last. A command that
 * went on instead of refusing it, as `landing-turn.cjs land --quick-precheck` once started a real landing, would
 * act in an empty folder outside any repository and with an empty home, where it fails without naming either.
 */
const REFUSES: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  ".github/scripts/check-changed-receipt.cjs": [["verify", "HEAD", "HEAD", UNREAD]],
  ".github/scripts/ci-changes.cjs": [[UNREAD], ["--full", "positional"]],
  ".github/scripts/fork-release.cjs": [
    ["public-config", ".env.example", UNREAD],
    ["carry-macos-feed", "v1", "latest-mac.yml", UNREAD],
  ],
  ".github/scripts/landing-turn.cjs": [
    ["land", UNREAD],
    ["push", UNREAD],
    ["verify", "origin", UNREAD],
  ],
  ".github/scripts/release-notes.cjs": [
    ["configure", UNREAD],
    ["merge", "base", "ours", "theirs", UNREAD],
  ],
  "apps/mobile/scripts/generate-uniwind-themes.mts": [["--chek"]],
  "apps/mobile/scripts/upload-sourcemaps.mts": [
    ["ota", "dist", UNREAD],
    ["build", UNREAD],
  ],
  "evals/mcp-tool-use/trim-capture.ts": [["claude", "capture.json", "out.json.gz", UNREAD]],
  "infra/relay/scripts/android-push-smoke.ts": [["sa.json", "device.json", "running", UNREAD]],
  "infra/relay/scripts/android-push-watch.ts": [
    ["sa.json", "device.json", "connection.json", UNREAD],
  ],
  "infra/task-cache/scripts/install.ts": [["--uninstal"]],
  "packages/source-control-github/scripts/measure-pr-preview.ts": [["owner/repo", "1", UNREAD]],
  "scripts/i18n-catalog.ts": [
    ["check", UNREAD],
    ["missing", "missing.json", UNREAD],
  ],
  "scripts/render-metrics.ts": [
    ["run", "--runs", "0", UNREAD],
    ["compare", "before.json", "after.json", UNREAD],
  ],
  "scripts/test-cached.ts": [[UNREAD]],
  "scripts/upstream-sync.ts": [
    ["begin", UNREAD],
    ["status", UNREAD],
    ["land", UNREAD],
    ["check", UNREAD],
  ],
};

// Source map uploads never fail a release, so a wrong command line is a warning there too.
const WARNS_ONLY = new Set(["apps/mobile/scripts/upload-sourcemaps.mts"]);

/** Scripts that read process.argv without parsing a command line of their own. */
const EXEMPT: Readonly<Record<string, string>> = {
  "apps/desktop/scripts/ensure-electron-runtime.mjs": "reads only its own path, to tell it was run",
  "apps/desktop/scripts/verify-preload-bundle.mjs": "reads only its own path, to tell it was run",
  // The recorders start provider runs, which cost money, so the strict-mode check below covers them instead of a run.
  "apps/server/scripts/replayRecorderArguments.ts":
    "parses the replay recorders' command lines in parseArgs's strict mode",
  "scripts/build-desktop-artifact.ts": "reads it only in the probe it runs in a child Node",
  "scripts/mobile-behavior/fake-fx.ts":
    "stands in for fx in tests, answering what the fx adapter sends",
  "scripts/mobile-native-client.ts": "reads it only in the code it runs with `node -e`",
  "scripts/npm-launcher/t3.mjs": "passes its command line to the t3 executable, which checks it",
  "scripts/profile-startup.mjs": "passes its command line to the dev runner, which checks it",
};

const SKIPPED_DIRECTORY = /^(?:src|test|tests|__tests__|fixtures|testkit|node_modules)$/;
const CODE = /\.[cm]?[jt]sx?$/;

/** Tracked scripts outside vendored repositories, app sources and tests, with their text. */
function trackedScripts(): ReadonlyArray<{ readonly file: string; readonly text: string }> {
  const listed = NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter(
      (file) =>
        CODE.test(file) &&
        !file.startsWith(".repos/") &&
        !/\.test\.[cm]?[jt]sx?$/.test(file) &&
        !file
          .split("/")
          .slice(0, -1)
          .some((part) => SKIPPED_DIRECTORY.test(part)),
    )
    .flatMap((file) => {
      const full = NodePath.join(root, file);
      // A sparse checkout leaves some tracked files out of the tree.
      return NodeFS.existsSync(full) ? [{ file, text: NodeFS.readFileSync(full, "utf8") }] : [];
    });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("command-line scripts", () => {
  const scripts = trackedScripts();

  it("lists every script that reads process.argv, and no file that is gone", () => {
    const readers = scripts
      .filter(({ text }) => text.includes("process.argv"))
      .map(({ file }) => file);
    const listed = new Set([...Object.keys(REFUSES), ...Object.keys(EXEMPT)]);
    expect(readers.filter((file) => !listed.has(file))).toEqual([]);
    const tracked = new Set(scripts.map(({ file }) => file));
    expect([...listed].filter((file) => !tracked.has(file))).toEqual([]);
  });

  it("parses with util.parseArgs only in its strict mode, which refuses an unknown option", () => {
    const loose = scripts
      .filter(({ text }) => text.includes("parseArgs(") && /\bstrict:\s*false\b/.test(text))
      .map(({ file }) => file);
    expect(loose).toEqual([]);
  });

  const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-command-arguments-"));
  afterAll(() => NodeFS.rmSync(empty, { recursive: true, force: true }));
  // Hooks export GIT_DIR, landings export their turn, and credentials come from T3 variables: none reach the child.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(?:GIT_|T3|MOBILE_SOURCEMAPS_)/.test(name)),
    ),
    HOME: empty,
    USERPROFILE: empty,
    GIT_CEILING_DIRECTORIES: NodePath.dirname(empty),
  };

  describe.concurrent.each(Object.entries(REFUSES))("%s", (file, commandLines) => {
    it.each(commandLines.map((argv) => [argv.join(" "), argv] as const))(
      "refuses `%s`",
      async (_, argv) => {
        const result = await new Promise<{ status: number | null; output: string }>(
          (resolve, reject) => {
            // Stopped inside the project's 60-second test limit, a script that hangs fails here with its output.
            const child = NodeChildProcess.spawn(
              process.execPath,
              [NodePath.join(root, file), ...argv],
              { cwd: empty, env, stdio: ["ignore", "pipe", "pipe"], timeout: 45_000 },
            );
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk));
            child.stderr.on("data", (chunk) => (output += chunk));
            child.on("error", reject);
            child.on("close", (status) => resolve({ status, output }));
          },
        );
        if (!WARNS_ONLY.has(file)) expect(result.status, result.output).not.toBe(0);
        expect(result.status, result.output).not.toBeNull();
        expect(result.output).toMatch(new RegExp(`usage|${escapeRegExp(argv.at(-1) ?? "")}`, "i"));
      },
    );
  });
});
