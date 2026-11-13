const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readWorkspace } = require("./ci-changes.cjs");

function checkNodeRuntime() {
  const root = path.resolve(__dirname, "../..");
  const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const expected = readManifest(root).engines.node;
  if (!/^\d+\.\d+\.\d+$/.test(expected)) {
    throw new Error("package.json engines.node must pin an exact development Node version.");
  }
  const failures = [];
  const env = { ...process.env };
  // Vite+ prepends the running Node's bin directory; restore shim lookup for each package.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  if (pathKey) {
    env[pathKey] = env[pathKey]
      .split(path.delimiter)
      .filter((entry) => !/[\\/]js_runtime[\\/]node[\\/]/.test(entry))
      .join(path.delimiter);
  }
  delete env.VP_NODE_VERSION;
  delete env.VP_PATH_INJECTED_TOOLS;
  const directories = [".", ...readWorkspace().map((pkg) => pkg.dir)];
  for (const dir of directories) {
    const cwd = path.join(root, dir);
    const manifest = readManifest(cwd);
    const runtime = manifest.devEngines?.runtime;
    const nodeRuntime = (Array.isArray(runtime) ? runtime : [runtime]).find(
      (entry) => entry?.name === "node",
    );
    const versionFile = path.join(cwd, ".node-version");
    const declared = fs.existsSync(versionFile)
      ? fs.readFileSync(versionFile, "utf8").trim().replace(/^v/, "")
      : (nodeRuntime?.version ?? manifest.engines?.node);
    // A CI/session override can hide a package range selecting a different Node in a fresh shell.
    if (declared && declared !== expected) {
      failures.push(
        `${dir}: set devEngines.runtime to node ${expected}; keep engines.node as the published support range.`,
      );
    }
    const result = spawnSync("node", ["--version"], {
      cwd,
      env,
      encoding: "utf8",
      // Windows cannot spawn a .cmd shim without a shell; the arguments are constant.
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node tooling has no Effect runtime.
      shell: process.platform === "win32",
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      failures.push(`${dir}: cannot resolve Node: ${result.error?.message ?? result.stderr}`);
    } else if (result.stdout.trim() !== `v${expected}`) {
      failures.push(`${dir}: resolved ${result.stdout.trim()}, expected v${expected}.`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return `Node runtime check: ${directories.length} workspace directories use v${expected}.`;
}

module.exports = { checkNodeRuntime };

if (require.main === module) {
  try {
    console.log(checkNodeRuntime());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
