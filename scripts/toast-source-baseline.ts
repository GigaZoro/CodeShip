#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A synchronous maintainer script over oxlint's output.
// Rewrites oxlint-plugin-t3code/rules/require-toast-source.baseline.json: how many
// toastManager.add calls in each apps/web file still have no data.source. Run it after
// tagging toasts, or after an upstream sync brings new untagged ones.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const BASELINE = NodePath.join(
  ROOT,
  "oxlint-plugin-t3code/rules/require-toast-source.baseline.json",
);
const RULE = "require-toast-source";

const requireFromRoot = NodeModule.createRequire(NodePath.join(ROOT, "package.json"));
const oxlintPackage = NodeModule.createRequire(
  requireFromRoot.resolve("vite-plus/package.json"),
).resolve("oxlint/package.json");
const oxlintBin = NodePath.join(NodePath.dirname(oxlintPackage), "bin", "oxlint");

const configDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "toast-source-baseline-"));
try {
  const configPath = NodePath.join(configDir, "oxlintrc.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: [
        { name: "t3code", specifier: NodePath.join(ROOT, "oxlint-plugin-t3code/index.ts") },
      ],
      rules: { [`t3code/${RULE}`]: ["error", { grandfathered: {} }] },
      ignorePatterns: ["**/*.test.ts", "**/*.test.tsx", "**/test/**"],
    }),
  );
  const run = NodeChildProcess.spawnSync(
    process.execPath,
    [oxlintBin, "--config", configPath, "-f", "json", "apps/web/src"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  // oxlint exits 1 when it reports anything, which is the point here.
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`oxlint exited with ${run.status}: ${run.stderr}`);
  }
  const parsed = JSON.parse(run.stdout) as {
    diagnostics: ReadonlyArray<{ code?: string; filename: string }>;
  };
  const counts = new Map<string, number>();
  for (const diagnostic of parsed.diagnostics) {
    if (!diagnostic.code?.includes(RULE)) continue;
    const file = diagnostic.filename.replaceAll("\\", "/");
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  const sorted = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
  NodeFS.writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  console.log(`${counts.size} files, ${total} untagged toasts`);
} finally {
  NodeFS.rmSync(configDir, { recursive: true, force: true });
}
