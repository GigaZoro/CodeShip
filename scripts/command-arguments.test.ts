// @effect-diagnostics nodeBuiltinImport:off - Runs the repository's command-line scripts as child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import ts from "typescript-legacy";
import { parseBehaviorArguments } from "./mobile-behavior.ts";
import { parseE2eArguments } from "./mobile-e2e.ts";
import { parseShowcaseCliArgs } from "./mobile-showcase.ts";
import { parseRenderMetricsArguments } from "./render-metrics.ts";
import { parseCachedTestArguments } from "./test-cached.ts";
import { isChangedTestScript } from "./lib/cached-tests.ts";
import {
  isRepositoryCommandManifest,
  isRepositoryCommandSource,
} from "./lib/repository-command-source.ts";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { GIT_OUTPUT_MAX_BYTES } from "../.github/scripts/git-history.cjs";

const root = NodePath.resolve(import.meta.dirname, "..");
const UNREAD = "--no-such-argument";

type Refusal = readonly [argv: ReadonlyArray<string>, status: number, diagnostic: string];

const unknownOption = (name: string) => "Unknown option '" + name + "'";
const landingUsage =
  "usage: landing-turn.cjs land | land-rebased --base <sha> --head <sha> | push <commit> | holder | verify <remote>";
const metadataPackageUsage = "Usage: node package.mjs <helpers|verify> <directory> <rust-target>";
const metadataSigningUsage = "Usage: node scripts/sign-macos.ts --verify-codex-metadata";
const wakeUsageUsage = "Usage: node scripts/wake-usage.mjs <statev2.sqlite> <YYYY-MM-DD UTC>";
const REFUSES: Readonly<Record<string, ReadonlyArray<Refusal>>> = {
  "../.github/scripts/bounded-git.cjs": [
    [[UNREAD, "status"], 2, "usage: bounded-git.cjs <timeoutMs> <git args…>"],
    [["1000"], 2, "usage: bounded-git.cjs <timeoutMs> <git args…>"],
  ],
  "./lib/run-cached-test-group.ts": [
    [[], 1, "A cached test group requires at least one test file"],
    [[UNREAD], 1, "Unknown option"],
    [[NodePath.join(root, "scripts/lib/cached-tests.test.ts"), UNREAD], 1, "Unknown option"],
    [["--help", UNREAD], 1, "--help must be used alone."],
  ],
  "../.github/scripts/check-changed-receipt.cjs": [
    [
      ["verify", "HEAD", "HEAD", UNREAD],
      1,
      "Usage: node .github/scripts/check-changed-receipt.cjs verify",
    ],
  ],
  "../.github/scripts/ci-changes.cjs": [
    [[UNREAD], 1, unknownOption(UNREAD)],
    [["--full", "positional"], 1, "Unexpected argument 'positional'"],
    [["--paths", "one", "--paths", "two"], 1, "Pass --paths at most once."],
  ],
  "../.github/scripts/fork-release.cjs": [
    [["public-config", ".env.example", UNREAD], 1, "Usage: fork-release.cjs public-config"],
    [
      ["carry-macos-feed", "v1", "latest-mac.yml", UNREAD],
      1,
      "Usage: fork-release.cjs public-config",
    ],
  ],
  "../.github/scripts/landing-turn.cjs": [
    [["land", UNREAD], 2, landingUsage],
    [["land-rebased", "--base", "0".repeat(40), "--head", UNREAD], 2, landingUsage],
    [["push"], 2, landingUsage],
    [["push", "0".repeat(40), UNREAD], 2, landingUsage],
    [["holder", UNREAD], 2, landingUsage],
    [["verify", "origin", UNREAD], 2, landingUsage],
  ],
  "../.github/scripts/release-macos-run.cjs": [
    [
      ["GigaZoro/CodeShip", "1", UNREAD],
      2,
      "usage: node .github/scripts/release-macos-run.cjs <owner/repo> <Release (fork) run id>",
    ],
  ],
  "../.github/scripts/process-tree.cjs": [
    [["anchor", "{}", UNREAD], 2, "usage: process-tree.cjs anchor <spec> | stop <group>"],
    [["stop", "4194304", UNREAD], 2, "usage: process-tree.cjs anchor <spec> | stop <group>"],
    [["stop", "group"], 2, "usage: process-tree.cjs anchor <spec> | stop <group>"],
  ],
  "../.github/scripts/release-notes.cjs": [
    [["configure", UNREAD], 1, "Usage: node .github/scripts/release-notes.cjs check|render"],
    [
      ["merge", "base", "ours", "theirs", UNREAD],
      1,
      "Usage: node .github/scripts/release-notes.cjs check|render",
    ],
  ],
  "../apps/mobile/scripts/upload-sourcemaps.mts": [
    [
      ["ota", "dist", UNREAD],
      0,
      "warning: Source map upload skipped: Usage: upload-sourcemaps.mts ota <dist-dir> | build",
    ],
    [
      ["build", UNREAD],
      0,
      "warning: Source map upload skipped: Usage: upload-sourcemaps.mts ota <dist-dir> | build",
    ],
  ],
  "../apps/server/scripts/run-replay-recorder.ts": [
    [["invalid-recorder"], 1, "Usage: run-replay-recorder.ts codex|claude [recorder arguments]"],
  ],
  "../docs/operations/codex-metadata/package.mjs": [
    [["verify", "package", "aarch64-apple-darwin", UNREAD], 1, metadataPackageUsage],
    [["helpers", "package", "unsupported", UNREAD], 1, metadataPackageUsage],
    [["helpers", "package"], 1, metadataPackageUsage],
    [["verify", "  ", "x86_64-pc-windows-msvc"], 1, metadataPackageUsage],
    [["helpers", "package", "constructor"], 1, "Unsupported Codex metadata target: constructor"],
  ],
  "../evals/mcp-tool-use/trim-capture.ts": [
    [["claude", "capture.json", "out.json.gz", UNREAD], 1, "Usage: trim-capture.ts <claude|codex>"],
  ],
  "../infra/relay/scripts/android-push-smoke.ts": [
    [
      ["sa.json", "device.json", "running", UNREAD],
      1,
      "Usage: node scripts/android-push-smoke.ts <service-account.json>",
    ],
  ],
  "../infra/relay/scripts/android-push-watch.ts": [
    [
      ["sa.json", "device.json", "connection.json", UNREAD],
      1,
      "Usage: node scripts/android-push-watch.ts <service-account.json>",
    ],
  ],
  "../infra/task-cache/scripts/install.ts": [
    [["--uninstal"], 1, unknownOption("--uninstal")],
    [["--uninstall", "--entrypoint="], 1, "--entrypoint must be a non-blank path."],
    [
      ["--uninstall", "--entrypoint", "custom.js"],
      1,
      "--uninstall cannot be combined with --entrypoint",
    ],
    [["--uninstall", "--non-interactive"], 1, "--uninstall cannot be combined with --entrypoint"],
    [["--uninstall", "--uninstall"], 1, "Pass --uninstall at most once."],
  ],
  "../packages/source-control-github/scripts/measure-pr-preview.ts": [
    [
      ["owner/repo", "1", UNREAD],
      1,
      "Usage: node packages/source-control-github/scripts/measure-pr-preview.ts owner/repo number...",
    ],
  ],
  "./i18n-catalog.ts": [
    [
      ["check", UNREAD],
      1,
      "Usage: node scripts/i18n-catalog.ts check | missing <file> | merge <file>...",
    ],
    [
      ["missing", "missing.json", UNREAD],
      1,
      "Usage: node scripts/i18n-catalog.ts check | missing <file> | merge <file>...",
    ],
  ],
  "./mobile-behavior/fake-fx.ts": [
    [["status", "--typo"], 2, "fake-fx: unsupported command status --typo"],
    [["models", "--json", UNREAD], 2, "fake-fx: unsupported command models --json " + UNREAD],
    [["acp", UNREAD], 2, "fake-fx: unsupported command acp " + UNREAD],
    [["--version", UNREAD], 2, "fake-fx: unsupported command --version " + UNREAD],
  ],
  "./render-metrics.ts": [
    [["compare", "before.json", "after.json", UNREAD], 1, unknownOption(UNREAD)],
  ],
  "./sign-macos.ts": [
    [["--verify-codex-metadata", "Test.app", "staged", UNREAD], 1, metadataSigningUsage],
    [["--verify-codex-metadata", "Test.app"], 1, metadataSigningUsage],
    [["--verify-codex-metadata", " ", "staged"], 1, "App must be a non-blank path."],
    [["--verify-codex-metadata", "Test.app", " "], 1, "Staged package must be a non-blank path."],
  ],
  "./wake-usage.mjs": [
    [["statev2.sqlite", "2026-11-25", UNREAD], 1, wakeUsageUsage],
    [["statev2.sqlite"], 1, wakeUsageUsage],
  ],
  "./upstream-sync.ts": ["begin", "status", "land", "check"].map((command) => [
    [command, UNREAD],
    2,
    "Usage: node scripts/upstream-sync.ts begin | status | land | check",
  ]),
};

const PARSER_CHECKS = {
  "./test-cached.ts": parseCachedTestArguments,
  "./mobile-behavior.ts": parseBehaviorArguments,
  "./mobile-e2e.ts": parseE2eArguments,
  "./mobile-showcase.ts": parseShowcaseCliArgs,
  "./render-metrics.ts": (args: ReadonlyArray<string>) =>
    parseRenderMetricsArguments(["run", ...args]),
};

/** Argv readers whose command line is delegated, or whose parser is exercised by its own tests. */
const EXEMPT: Readonly<Record<string, string>> = {
  "../apps/mobile/scripts/generate-uniwind-themes.mts":
    "the mobile theme tests exercise the CLI in a disposable project",
  "../apps/desktop/scripts/ensure-electron-runtime.mjs":
    "reads only its own path, to tell it was run",
  "../apps/desktop/scripts/verify-preload-bundle.mjs":
    "reads only its own path, to tell it was run",
  "../apps/server/scripts/probe-claude-fork-local-rollback-replay.ts":
    "uses the shared replay parser",
  "../apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts":
    "covered by the Claude replay parser tests",
  "../apps/server/scripts/record-muse-msp-replay-fixture.ts": "uses the shared replay parser",
  "../apps/server/scripts/record-pi-rpc-replay-fixture.ts": "uses the shared replay parser",
  "../apps/desktop/scripts/build-browser-secret.mjs":
    "uses parseCommandLine before invoking the compiler",
  "../apps/server/scripts/verify-background-live.ts":
    "uses parseCommandLine before launching services",
  "./smoke-desktop-app.ts": "uses parseCommandLine before launching the desktop app",
  "../evals/test-signal/run.ts": "uses parseCommandLine before invoking a model",
  "../evals/thread-titles/run.ts": "uses parseCommandLine before invoking a model",
  "../evals/mcp-tool-use/run.ts": "uses parseCommandLine before invoking a model",
  "./lib/command-line.ts": "implements the shared parser and forwards its caller's config",
  "../apps/server/scripts/record-codex-app-server-replay-fixture.ts":
    "covered by the replay recorder parser tests",
  "../apps/server/scripts/record-fx-acp-replay-fixture.ts":
    "covered by the replay recorder parser tests",
  "../apps/server/scripts/record-grok-acp-replay-fixture.ts":
    "covered by the replay recorder parser tests",
  "./build-desktop-artifact.ts": "reads it only in the probe it runs in a child Node",
  "./mobile-native-client.ts": "reads it only in the code it runs with node -e",
  "./npm-launcher/t3.mjs": "passes its command line to the t3 executable, which checks it",
  "./profile-startup.mjs": "passes its command line to the dev runner, which checks it",
};

const toRepositoryPath = (file: string) => NodePath.posix.normalize("scripts/" + file);

/** Tracked files that `keep` takes, with their text. */
function trackedFiles(
  keep: (file: string) => boolean,
): ReadonlyArray<{ readonly file: string; readonly text: string }> {
  const listed = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_MAX_BYTES,
    },
  );
  return listed
    .split("\0")
    .filter(keep)
    .flatMap((file) => {
      const full = NodePath.join(root, file);
      // A sparse checkout leaves some tracked files out of the tree.
      return NodeFS.existsSync(full) ? [{ file, text: NodeFS.readFileSync(full, "utf8") }] : [];
    });
}

// parseArgs reads process.argv when its config names no args, and parseCommandLine hands its config to parseArgs.
const DEFAULT_ARGV_PARSERS = new Set(["parseArgs", "parseCommandLine"]);

function readsArgv(text: string): boolean {
  if (!text.includes("argv") && !/\b(?:parseArgs|parseCommandLine)\b/.test(text)) return false;
  // These scripts embed Node source in strings, so keep finding the global spelling there too.
  if (/\bprocess\s*\.\s*argv\b/.test(text)) return true;
  const module = ts.createSourceFile("script.ts", text, ts.ScriptTarget.Latest, true);
  const processNames = new Set(["process"]);
  const argvNames = new Set<string>();
  const parserNames = new Set(DEFAULT_ARGV_PARSERS);
  const isProcessModule = (node: ts.Node | undefined) =>
    node !== undefined && ts.isStringLiteralLike(node) && /^(node:)?process$/.test(node.text);
  const addBinding = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) processNames.add(name.text);
    else if (ts.isObjectBindingPattern(name)) {
      for (const item of name.elements) {
        const property = item.propertyName ?? item.name;
        if (ts.isIdentifier(item.name) && ts.isIdentifier(property) && property.text === "argv")
          argvNames.add(item.name.text);
      }
    }
  };
  const isModuleLoad = (node: ts.Expression | undefined) => {
    const expression = node && ts.isAwaitExpression(node) ? node.expression : node;
    return (
      expression !== undefined &&
      ts.isCallExpression(expression) &&
      (expression.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression.expression) && expression.expression.text === "require")) &&
      isProcessModule(expression.arguments[0])
    );
  };
  const collectImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:(?:node:)?util|.*\/command-line\.ts)$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (DEFAULT_ARGV_PARSERS.has((binding.propertyName ?? binding.name).text))
            parserNames.add(binding.name.text);
        }
      }
    }
    if (ts.isImportDeclaration(node) && isProcessModule(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) processNames.add(clause.name.text);
      const names = clause?.namedBindings;
      if (names && ts.isNamespaceImport(names)) processNames.add(names.name.text);
      if (names && ts.isNamedImports(names)) {
        for (const binding of names.elements) {
          const exported = (binding.propertyName ?? binding.name).text;
          if (exported === "default") processNames.add(binding.name.text);
          if (exported === "argv") argvNames.add(binding.name.text);
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isProcessModule(node.moduleReference.expression)
    ) {
      processNames.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && isModuleLoad(node.initializer)) {
      addBinding(node.name);
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(module);
  const readsProcess = (node: ts.Expression): boolean =>
    (ts.isIdentifier(node) && processNames.has(node.text)) ||
    isModuleLoad(node) ||
    (ts.isParenthesizedExpression(node) && readsProcess(node.expression)) ||
    (ts.isPropertyAccessExpression(node) &&
      node.name.text === "default" &&
      readsProcess(node.expression));
  const collectDestructuring = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      readsProcess(node.initializer)
    ) {
      addBinding(node.name);
    }
    ts.forEachChild(node, collectDestructuring);
  };
  collectDestructuring(module);
  // A spread alone cannot prove that the caller supplied args.
  const passesArgs = (config: ts.Expression | undefined) =>
    config !== undefined &&
    ts.isObjectLiteralExpression(config) &&
    config.properties.some(
      (property) =>
        property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "args",
    );
  const calleeName = (callee: ts.Expression) =>
    ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
  const visit = (node: ts.Node): boolean | undefined => {
    if (
      ts.isCallExpression(node) &&
      parserNames.has(calleeName(node.expression) ?? "") &&
      !passesArgs(node.arguments[0])
    )
      return true;
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "argv" &&
      readsProcess(node.expression)
    )
      return true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "argv" &&
      readsProcess(node.expression)
    )
      return true;
    if (
      ts.isIdentifier(node) &&
      argvNames.has(node.text) &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isBindingElement(node.parent)
    )
      return true;
    return ts.forEachChild(node, visit);
  };
  return visit(module) === true;
}

const releaseNotes = "../.github/scripts/release-notes.cjs";
function commandPath(file: string, sandbox: string): string {
  const path = toRepositoryPath(file);
  if (file !== releaseNotes) return NodePath.join(root, path);
  const target = NodePath.join(sandbox, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  for (const script of [NodePath.basename(path), "git-history.cjs"]) {
    NodeFS.copyFileSync(
      NodePath.join(root, NodePath.dirname(path), script),
      NodePath.join(NodePath.dirname(target), script),
    );
  }
  return target;
}

function expectRefusal(
  result: { status: number | null; output: string },
  status: number,
  diagnostic: string,
) {
  expect(result.status, result.output).toBe(status);
  expect(result.output).toContain(diagnostic);
}

describe("command-line scripts", () => {
  const scripts = trackedFiles(isRepositoryCommandSource);

  it("lists every argv reader and no file that is gone", () => {
    const readers = scripts.filter(({ text }) => readsArgv(text)).map(({ file }) => file);
    const listed = new Set(
      [...Object.keys(REFUSES), ...Object.keys(PARSER_CHECKS), ...Object.keys(EXEMPT)].map(
        toRepositoryPath,
      ),
    );
    expect(readers.filter((file) => !listed.has(file))).toEqual([]);
    const exemptNonReaders = Object.keys(EXEMPT)
      .map(toRepositoryPath)
      .filter((file) => !readers.includes(file));
    expect(exemptNonReaders).toEqual([]);
    const tracked = new Set(scripts.map(({ file }) => file));
    expect([...listed].filter((file) => !tracked.has(file))).toEqual([]);
  });

  it.each([
    'import * as runtime from "node:process"; runtime.argv.slice(2);',
    'import runtime from "node:process"; runtime["argv"];',
    'import { argv as args } from "node:process"; args.slice(2);',
    'import { default as runtime } from "node:process"; runtime.argv;',
    'const { argv: args } = require("node:process"); args.slice(2);',
    'const runtime = await import("node:process"); runtime.argv;',
    '(await import("node:process")).argv;',
    '(await import("node:process")).default.argv;',
    'import * as runtime from "node:process"; const { argv: args } = runtime; args.slice(2);',
    'import * as NodeUtil from "node:util"; NodeUtil.parseArgs({ options: {} });',
    'import { parseArgs } from "node:util"; parseArgs();',
    'import { parseArgs as read } from "node:util"; read({ ...defaults });',
    'import { parseCommandLine } from "./lib/command-line.ts"; parseCommandLine({ options: {} });',
  ])("discovers argv in %s", (source) => {
    expect(readsArgv(source)).toBe(true);
  });

  it("ignores a process import that does not read argv", () => {
    expect(readsArgv('import runtime from "node:process"; runtime.env; const argv = [];')).toBe(
      false,
    );
    expect(readsArgv('parseCommandLine({ args: ["--check"], options: {} });')).toBe(false);
  });

  it("requires the specific refusal and exit status", () => {
    expect(() =>
      expectRefusal({ status: 1, output: "ENOENT: " + UNREAD }, 1, unknownOption(UNREAD)),
    ).toThrow();
    expect(() =>
      expectRefusal(
        { status: 1, output: "warning: Source map upload skipped" },
        0,
        "warning: Source map upload skipped",
      ),
    ).toThrow();
  });

  it.each(Object.entries(PARSER_CHECKS))(
    "%s refuses unknown options before dispatch",
    (_, parse) => {
      expect(() => parse(["--lsit"])).toThrow(/Unknown option/i);
    },
  );

  it("parses with util.parseArgs only in its strict mode, which refuses an unknown option", () => {
    const loose = scripts
      .filter(({ text }) => text.includes("parseArgs(") && /\bstrict:\s*false\b/.test(text))
      .map(({ file }) => file);
    expect(loose).toEqual([]);
  });

  // check:changed runs this test when a manifest changes, so the change that adds such a script
  // fails, not the next one that changes a test in that package.
  it("gives every package a test script check:changed can run", () => {
    const unsupported = trackedFiles(
      (file) => file !== "package.json" && isRepositoryCommandManifest(file),
    ).flatMap(({ file, text }) => {
      const manifest: { readonly scripts?: { readonly test?: unknown } } = JSON.parse(text);
      const test = manifest.scripts?.test;
      return typeof test === "string" && !isChangedTestScript(test) ? [`${file}: ${test}`] : [];
    });
    expect(unsupported).toEqual([]);
  });

  it("checks cached-runner help before starting any test work", () => {
    expect(() => parseCachedTestArguments(["--help", "positional"])).toThrow(
      "--help must be used alone.",
    );
    expect(parseCachedTestArguments(["--", "--help"]).values.help).toBe(true);
  });

  it.each([
    [["--shard=", "apps/server"], "Shard must be index/count"],
    [["--shard=2/1", "apps/server"], "Shard must be index/count"],
    [["--shard=1/9007199254740992", "apps/server"], "Shard must be index/count"],
    [["--shard=1/2"], "Sharding requires exactly one test project directory"],
    [["--shard=1/2", "server", "shared"], "Sharding requires exactly one test project directory"],
    [["--verify-hits="], "--verify-hits must be a non-negative safe integer."],
    [["--verify-hits=-1"], "--verify-hits must be a non-negative safe integer."],
    [["--verify-hits=9007199254740992"], "--verify-hits must be a non-negative safe integer."],
    [["--group-size=0"], "--group-size must be a positive safe integer."],
    [["--concurrency=1e3"], "--concurrency must be a positive safe integer."],
    [["--report="], "--report must be a non-blank path."],
    [["--uncached", "ok.test.ts", "--uncached= "], "--uncached must be a non-blank path."],
    [[""], "Test file or directory must be a non-blank path."],
  ] as const)("rejects cached runner args %j before discovery", (argv, message) => {
    expect(() => parseCachedTestArguments(argv)).toThrow(message);
  });

  it("accepts cached runner paths, repeated exceptions and the package runner separator", () => {
    const args = parseCachedTestArguments([
      "--",
      "--group-size=2",
      "--concurrency=9007199254740991",
      "--verify-hits=0",
      "--shard=01/02",
      "--report= reports/my report.json ",
      "--uncached",
      "tests/first file.test.ts",
      "--uncached=tests/second file.test.ts",
      "project with spaces",
    ]);
    expect(args).toMatchObject({
      groupSize: 2,
      concurrency: Number.MAX_SAFE_INTEGER,
      verifyHits: 0,
      values: {
        shard: "01/02",
        report: " reports/my report.json ",
        uncached: ["tests/first file.test.ts", "tests/second file.test.ts"],
      },
      positionals: ["project with spaces"],
    });
    expect(parseCachedTestArguments(["--", "--", "--literal-path"]).positionals).toEqual([
      "--literal-path",
    ]);
  });

  it("rejects mobile behavior values that would be ignored or reach the device runner", () => {
    expect(() => parseBehaviorArguments(["--list", "--device", "iphone-18-pro"])).toThrow(
      "--list must be used alone.",
    );
    expect(() => parseBehaviorArguments(["--samples", "0"])).toThrow(
      "--samples must be a positive safe integer.",
    );
    expect(() => parseBehaviorArguments(["--case", "scroll-up-never-teleports,typo"])).toThrow(
      /Unknown case id.*typo/,
    );
    expect(
      parseBehaviorArguments(["--device", "iphone-18-pro", "--samples", "1"]).passThrough,
    ).toEqual(["--samples", "1"]);
  });

  it("rejects a mobile behavior case that no selected device runs", () => {
    expect(() => parseBehaviorArguments(["--case", "folded-duo-back-opens-right-thread"])).toThrow(
      "Case(s) folded-duo-back-opens-right-thread run on none of the devices iphone-18-pro, ipad-pro-13.",
    );
    expect(() =>
      parseBehaviorArguments([
        "--device",
        "iphone-18-pro",
        "--case",
        "scroll-up-never-teleports,folded-duo-back-opens-right-thread",
      ]),
    ).toThrow("run on none of the devices iphone-18-pro.");
    expect(parseBehaviorArguments(["--case", "scroll-up-never-teleports"]).passThrough).toEqual([
      "--case",
      "scroll-up-never-teleports",
    ]);
  });

  it("rejects mobile e2e values before dispatch", () => {
    expect(() => parseE2eArguments(["--pose"])).toThrow(/argument missing/i);
    expect(() => parseE2eArguments(["--platform", "typo"])).toThrow("Unknown platform typo.");
    expect(() => parseE2eArguments(["--concurrency", "oops"])).toThrow(
      "--concurrency must be a positive safe integer.",
    );
    expect(() => parseE2eArguments(["--concurrency", "1", "--concurrency", "2"])).toThrow(
      "Pass --concurrency at most once.",
    );
    expect(
      parseE2eArguments(["--platform", "ios", "--platform", "android", "--no-review"]).review,
    ).toBe(false);
  });

  it("accepts the package runner separator for mobile behavior and e2e", () => {
    const behavior = ["--device", "iphone-18-pro", "--samples", "1"];
    const e2e = ["--platform", "ios", "--no-review"];
    expect(parseBehaviorArguments(["--", ...behavior])).toEqual(parseBehaviorArguments(behavior));
    expect(parseE2eArguments(["--", ...e2e])).toEqual(parseE2eArguments(e2e));
    expect(() => parseBehaviorArguments(["--", "--", ...behavior])).toThrow();
    expect(() => parseE2eArguments(["--", "--", ...e2e])).toThrow();
  });

  it("refuses other options alongside screenshot help", () => {
    expect(parseShowcaseCliArgs(["--help"]).list).toBe(true);
    expect(() => parseShowcaseCliArgs(["--help", "--skip-build"])).toThrow(
      "--help must be used alone.",
    );
  });

  // macOS tmpdir is a symlink (/var -> /private/var); compare real paths on both sides.
  const empty = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-command-arguments-")),
  );
  afterAll(() => NodeFS.rmSync(empty, { recursive: true, force: true }));

  it("runs the release notes command from a disposable copy", () => {
    const file = releaseNotes;
    const sandbox = NodeFS.mkdtempSync(NodePath.join(empty, "copy-"));
    const path = commandPath(file, sandbox);
    expect(NodePath.relative(sandbox, NodeFS.realpathSync(path))).toBe(
      NodePath.normalize(toRepositoryPath(file)),
    );
    expect(NodeFS.readFileSync(path, "utf8")).toBe(
      NodeFS.readFileSync(NodePath.join(root, toRepositoryPath(file)), "utf8"),
    );
  });

  it.each(["--help", "-h"])("writes standalone %s to stdout", (flag) => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(root, "scripts/render-metrics.ts"), flag],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Usage:/);
    expect(result.stderr).toBe("");
  });

  describe.concurrent.each(Object.entries(REFUSES))("%s", (file, commandLines) => {
    it.each(
      commandLines.map(
        ([argv, status, diagnostic]) => [argv.join(" "), argv, status, diagnostic] as const,
      ),
    )("refuses %s", async (_, argv, status, diagnostic) => {
      const sandbox = NodeFS.mkdtempSync(NodePath.join(empty, "case-"));
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) =>
              !/^(?:GIT_|T3|MOBILE_SOURCEMAPS_|GITHUB_ACTIONS$|NODE_OPTIONS$)/i.test(name),
          ),
        ),
        HOME: sandbox,
        USERPROFILE: sandbox,
        GIT_CEILING_DIRECTORIES: empty,
      };
      const path = commandPath(file, sandbox);
      const result = await new Promise<{ status: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn(process.execPath, [path, ...argv], {
            cwd: sandbox,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 45_000,
          });
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.on("error", reject);
          child.on("close", (status) => resolve({ status, output }));
        },
      );
      expectRefusal(result, status, diagnostic);
    });
  });
});
