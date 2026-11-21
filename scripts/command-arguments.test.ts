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
import { afterAll, describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const UNREAD = "--no-such-argument";

type Refusal = readonly [argv: ReadonlyArray<string>, status: number, diagnostic: string];

const unknownOption = (name: string) => "Unknown option '" + name + "'";
const REFUSES: Readonly<Record<string, ReadonlyArray<Refusal>>> = {
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
    [["land", UNREAD], 2, "usage: landing-turn.cjs land | push | verify <remote>"],
    [["push", UNREAD], 2, "usage: landing-turn.cjs land | push | verify <remote>"],
    [["verify", "origin", UNREAD], 2, "usage: landing-turn.cjs land | push | verify <remote>"],
  ],
  "../.github/scripts/release-notes.cjs": [
    [["configure", UNREAD], 1, "Usage: node .github/scripts/release-notes.cjs check|render"],
    [
      ["merge", "base", "ours", "theirs", UNREAD],
      1,
      "Usage: node .github/scripts/release-notes.cjs check|render",
    ],
  ],
  "../apps/mobile/scripts/generate-uniwind-themes.mts": [
    [["--chek"], 1, unknownOption("--chek")],
    [["--check", "--check"], 1, "Pass --check at most once."],
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
  "./test-cached.ts": [
    [[UNREAD], 1, unknownOption(UNREAD)],
    [["--help", "positional"], 1, "--help must be used alone."],
  ],
  "./upstream-sync.ts": ["begin", "status", "land", "check"].map((command) => [
    [command, UNREAD],
    2,
    "Usage: node scripts/upstream-sync.ts begin | status | land | check",
  ]),
};

const PARSER_CHECKS = {
  "./mobile-behavior.ts": parseBehaviorArguments,
  "./mobile-e2e.ts": parseE2eArguments,
  "./mobile-showcase.ts": parseShowcaseCliArgs,
  "./render-metrics.ts": (args: ReadonlyArray<string>) =>
    parseRenderMetricsArguments(["run", ...args]),
};

/** Argv readers whose command line is delegated, or whose parser is exercised by its own tests. */
const EXEMPT: Readonly<Record<string, string>> = {
  "../apps/desktop/scripts/ensure-electron-runtime.mjs":
    "reads only its own path, to tell it was run",
  "../apps/desktop/scripts/verify-preload-bundle.mjs":
    "reads only its own path, to tell it was run",
  "../apps/server/scripts/replayRecorderArguments.ts":
    "covered by the replay recorder parser tests",
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

const SKIPPED_DIRECTORY = /^(?:src|test|tests|__tests__|fixtures|testkit|node_modules)$/;
const CODE = /\.[cm]?[jt]sx?$/;

/** Tracked scripts outside vendored repositories, app sources and tests, with their text. */
function trackedScripts(): ReadonlyArray<{ readonly file: string; readonly text: string }> {
  const listed = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
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

function readsArgv(text: string): boolean {
  if (!text.includes("argv")) return false;
  // These scripts embed Node source in strings, so keep finding the global spelling there too.
  if (/\bprocess\s*\.\s*argv\b/.test(text)) return true;
  const module = ts.createSourceFile("script.ts", text, ts.ScriptTarget.Latest, true);
  const processNames = new Set(["process"]);
  const argvNames = new Set<string>();
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
  const visit = (node: ts.Node): boolean | undefined => {
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
const themes = "../apps/mobile/scripts/generate-uniwind-themes.mts";
const themeDependencies = [
  "../apps/mobile/package.json",
  "../apps/mobile/src/lib/mobileTheme.ts",
  "./lib/command-line.ts",
];

function commandPath(file: string, sandbox: string): string {
  if (file !== releaseNotes && file !== themes) return NodePath.join(root, toRepositoryPath(file));
  for (const source of file === themes ? [file, ...themeDependencies] : [file]) {
    const path = toRepositoryPath(source);
    const target = NodePath.join(sandbox, path);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(root, path), target);
  }
  if (file === themes) {
    NodeFS.symlinkSync(
      NodePath.join(root, "apps/mobile/node_modules"),
      NodePath.join(sandbox, "apps/mobile/node_modules"),
      "junction",
    );
  }
  return NodePath.join(sandbox, toRepositoryPath(file));
}

function expectRefusal(
  result: { status: number | null; output: string },
  status: number,
  diagnostic: string,
) {
  expect(result.status, result.output).toBe(status);
  expect(result.output).toContain(diagnostic);
}

// @test-input ../**/scripts/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}
// @test-input ../.github/scripts/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}
// @test-input ../evals/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}
describe("command-line scripts", () => {
  const scripts = trackedScripts();

  it("lists every argv reader and no file that is gone", () => {
    const readers = scripts.filter(({ text }) => readsArgv(text)).map(({ file }) => file);
    const listed = new Set(
      [...Object.keys(REFUSES), ...Object.keys(PARSER_CHECKS), ...Object.keys(EXEMPT)].map(
        toRepositoryPath,
      ),
    );
    expect(readers.filter((file) => !listed.has(file))).toEqual([]);
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
  ])("discovers argv in %s", (source) => {
    expect(readsArgv(source)).toBe(true);
  });

  it("ignores a process import that does not read argv", () => {
    expect(readsArgv('import runtime from "node:process"; runtime.env; const argv = [];')).toBe(
      false,
    );
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

  it("refuses other options alongside screenshot help", () => {
    expect(parseShowcaseCliArgs(["--help"]).list).toBe(true);
    expect(() => parseShowcaseCliArgs(["--help", "--skip-build"])).toThrow(
      "--help must be used alone.",
    );
  });

  const empty = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-command-arguments-"));
  afterAll(() => NodeFS.rmSync(empty, { recursive: true, force: true }));

  it.each([releaseNotes, themes])("runs %s from a disposable copy", (file) => {
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
