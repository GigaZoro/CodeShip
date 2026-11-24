// Release tooling also runs before pnpm installation, on the native Windows builder.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const version = "0.172.0";
// dist.integrity for the platform packages of @openai/codex@0.172.0 on registry.npmjs.org.
const platforms = {
  "aarch64-apple-darwin": {
    npm: "darwin-arm64",
    sha512:
      "B239wE7pGeOmjylfqLymDIwuL4QgQR7pQZc5phHpZ3t8UVkno9AS3dNPEprm7AzZHw3kf2I6Uf+uOFfjGegELQ==",
    helpers: [],
  },
  "x86_64-pc-windows-msvc": {
    npm: "win32-x64",
    sha512:
      "48pULjlTwpBZ/TfbOnpnmloHaTQAYELbaiKHEX7qmrtLFIcnPigaNN3omyetPdAuvrRXrmNFRlKfvQme19ZmRA==",
    helpers: [
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ],
  },
  "x86_64-unknown-linux-musl": {
    npm: "linux-x64",
    sha512:
      "YJq6Wz3PFXV5LZ0OQc3/o+gpM3pLmQ/8n8uM2zF/m0O/8zED+uSPT8Ln1KGRrqR8Q6eon9YdWlhueAunVTZ+eg==",
    helpers: ["codex-resources/bwrap"],
  },
};

function layout(target) {
  const platform = platforms[target];
  if (!platform) throw new Error(`Unsupported Codex metadata target: ${target}`);
  const suffix = platform.npm.startsWith("win32") ? ".exe" : "";
  return {
    ...platform,
    cli: `bin/codex${suffix}`,
    helpers: [`bin/codex-code-mode-host${suffix}`, `codex-path/rg${suffix}`, ...platform.helpers],
  };
}

export function verifyPackage(root, target, includeCli = true) {
  const { cli, helpers } = layout(target);
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, "codex-package.json"), "utf8"),
  );
  for (const [key, expected] of Object.entries({
    layoutVersion: 1,
    version,
    target,
    variant: "codex",
    entrypoint: cli,
    pathDir: "codex-path",
    resourcesDir: "codex-resources",
  })) {
    if (manifest[key] !== expected)
      throw new Error(`Invalid Codex package ${key}: expected ${expected}`);
  }
  for (const name of includeCli ? [cli, ...helpers] : helpers) {
    const file = NodePath.join(root, name);
    const stat = NodeFS.statSync(file, { throwIfNoEntry: false });
    const requireExecBits = NodePath.sep === "/" && !cli.endsWith(".exe");
    if (!stat?.isFile() || stat.size === 0 || (requireExecBits && !(stat.mode & 0o111))) {
      throw new Error(`Unusable Codex executable ${name} in ${root}`);
    }
  }
}

async function prepareHelpers(root, target) {
  const { npm, sha512, helpers } = layout(target);
  const archive = NodePath.resolve(`codex-${version}-${npm}.tgz`);
  NodeChildProcess.execFileSync(
    "curl",
    [
      "-fLsS",
      "--retry",
      "3",
      "--max-time",
      "600",
      "-o",
      archive,
      `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${npm}.tgz`,
    ],
    { stdio: "inherit" },
  );
  const hash = NodeCrypto.createHash("sha512");
  for await (const chunk of NodeFS.createReadStream(archive)) hash.update(chunk);
  if (hash.digest("base64") !== sha512)
    throw new Error(`Codex package checksum mismatch for ${target}`);

  NodeFS.mkdirSync(NodePath.join(root, "codex-resources"), { recursive: true });
  const members = ["codex-package.json", ...helpers].map(
    (name) => `package/vendor/${target}/${name}`,
  );
  // Use a relative archive name for GNU tar on Windows (a drive letter denotes a remote host).
  NodeChildProcess.execFileSync(
    "tar",
    ["-xzf", `codex-${version}-${npm}.tgz`, "-C", root, "--strip-components=3", ...members],
    { stdio: "inherit" },
  );
  verifyPackage(root, target, false);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [command, root, target] = process.argv.slice(2);
  if (command === "helpers") await prepareHelpers(root, target);
  else if (command === "verify") verifyPackage(root, target);
  else throw new Error("Usage: node package.mjs <helpers|verify> <directory> <rust-target>");
}
