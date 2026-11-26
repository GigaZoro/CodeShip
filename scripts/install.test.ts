// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local GitHub fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isDarwinHost, isLinuxHost } from "@t3tools/shared/testing/hostPlatform";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runtimePromotion } from "@t3tools/shared/runtimePromotion";
import { verifyBundledRuntimeRepair } from "./install.testkit.ts";

it("ships the same promotion protocol as SSH and service installation", async () => {
  const source = await NodeFSP.readFile(NodePath.join(import.meta.dirname, "install.sh"), "utf8");
  expect(source).toContain(runtimePromotion);
});

describe.runIf(isDarwinHost || isLinuxHost)("a competing npm publisher", () => {
  it.each([
    { phase: "first publication", probe: "ok", exit: 10 },
    { phase: "repair", probe: "ok", exit: 10 },
    { phase: "repair with a rollback", probe: "ok", exit: 10 },
    { phase: "repair with a rollback", probe: "exit 78", exit: 1 },
    { phase: "repair with a rollback", probe: "wrong version", exit: 1 },
    { phase: "startup", probe: "ok", exit: 0 },
    { phase: "startup", probe: "exit 78", exit: 1 },
    { phase: "TERM", probe: "ok", exit: 143 },
    { phase: "TERM", probe: "exit 78", exit: 143 },
  ])(
    "keeps the winner at its published path during $phase (probe=$probe)",
    async ({ phase, probe, exit }) => {
      const parent = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-npm-winner-"));
      const version = "1.2.3";
      const root = NodePath.join(parent, version);
      const prior = NodePath.join(parent, `.${version}.previous`);
      const staged = NodePath.join(parent, ".staging");
      const peer = NodePath.join(parent, ".npm");
      const probes = NodePath.join(parent, "probes");
      const install = async (
        directory: string,
        owner: string,
        healthy: boolean,
        reported = version,
      ) => {
        await NodeFSP.mkdir(directory);
        await NodeFSP.writeFile(NodePath.join(directory, "owner"), owner);
        await NodeFSP.writeFile(NodePath.join(directory, ".install-complete"), version);
        await NodeFSP.writeFile(
          NodePath.join(directory, "t3"),
          `#!/bin/sh\necho ${owner} >> "$PROBES"\necho "t3 v${reported}"\nexit ${healthy ? 0 : 78}\n`,
          { mode: 0o755 },
        );
      };
      try {
        await install(
          peer,
          "npm",
          probe !== "exit 78",
          probe === "wrong version" ? "2.0.0" : version,
        );
        await install(staged, "download", true);
        if (phase === "startup" || phase === "repair with a rollback") {
          await install(prior, "original", true);
        }
        if (phase.startsWith("repair")) {
          await install(root, "incomplete", false);
          await NodeFSP.writeFile(NodePath.join(root, ".install-complete"), "incomplete");
        }
        if (phase === "TERM") await install(root, "original", false);
        const child = NodeChildProcess.spawnSync(
          "sh",
          [
            "-c",
            `set -eu
${runtimePromotion}
perform() {
  cmd=$1; shift
  from=; to=
  for arg do from=$to; to=$arg; done
  if { [ "$PHASE" = 'first publication' ] && [ "$from" = "$STAGED" ] && [ "$to" != "$ROOT" ]; } ||
     { [ "$from" = "$PRIOR" ] && [ "$to" = "$ROOT" ]; }; then
    "$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$PEER" "$ROOT" || return 1
  fi
  command "$cmd" "$@" || return $?
  if [ "$PHASE" = TERM ] && [ "$from" = "$ROOT" ] && [ "$to" = "$PRIOR" ]; then kill -TERM "$$"; fi
  if [ "$PHASE" = 'repair with a rollback' ] && [ "$from" = "$ROOT" ] && [ "$to" = "$STAGED.previous" ]; then
    "$NODE" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$PEER" "$ROOT"
  fi
}
mv() { perform mv "$@"; }
perl() { perform perl "$@"; }
cat() {
  command cat "$@" || return $?
  if [ "$PHASE" = repair ] && [ "$PWD" -ef "$ROOT" ] && [ "$1" = .install-complete ] && [ -d "$PEER" ]; then
    mkdir "$ROOT.lock"
  fi
}
sleep() {
  # The old npm publisher takes its lock after the shell reads the stale marker.
  # Finish its two renames only when the other installer waits for that lock.
  if [ "$PHASE" = repair ] && [ -d "$ROOT.lock" ] && [ -d "$PEER" ]; then
    "$NODE" -e 'const fs = require("node:fs"); const [root, peer] = process.argv.slice(1);
      fs.renameSync(root, root + ".stale"); fs.renameSync(peer, root);
      fs.rmSync(root + ".stale", {recursive: true}); fs.rmdirSync(root + ".lock");' "$ROOT" "$PEER"
  else
    command sleep "$@"
  fi
}
trap t3_release_lock EXIT
trap 'exit 143' TERM
t3_acquire_lock "$PARENT" "$VERSION" 2 || exit 1
if [ "$PHASE" != startup ]; then
  t3_promote_runtime "$STAGED" || exit 1
  if [ "$t3_reused" = 1 ]; then exit 10; fi
fi`,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NODE: HostProcess.ExecutablePath.defaultValue(),
              PARENT: parent,
              VERSION: version,
              PHASE: phase,
              PROBES: probes,
              PRIOR: prior,
              PEER: peer,
              ROOT: root,
              STAGED: staged,
            },
          },
        );
        expect(child.status, child.stderr).toBe(exit);
        expect(await NodeFSP.readFile(NodePath.join(root, "owner"), "utf8")).toBe("npm");
        expect((await NodeFSP.readdir(root)).toSorted()).toEqual([
          ".install-complete",
          "owner",
          "t3",
        ]);
        expect((await NodeFSP.readFile(probes, "utf8")).split("\n")).toContain("npm");
        if (phase === "startup" || phase === "TERM" || phase === "repair with a rollback") {
          expect(await NodeFSP.readFile(NodePath.join(prior, "owner"), "utf8")).toBe("original");
        }
        if (phase === "repair with a rollback") {
          if (probe === "ok") {
            await expect(NodeFSP.stat(staged + ".previous")).rejects.toMatchObject({
              code: "ENOENT",
            });
          } else {
            expect(
              await NodeFSP.readFile(NodePath.join(staged + ".previous", "owner"), "utf8"),
            ).toBe("incomplete");
          }
        }
        await expect(NodeFSP.stat(root + ".lock")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await NodeFSP.rm(parent, { recursive: true, force: true });
      }
    },
  );
});

it.runIf(isDarwinHost || isLinuxHost)(
  "repairs a runtime whose version probe exceeds its deadline",
  async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-probe-deadline-"));
    try {
      const result = NodeChildProcess.spawnSync(
        "sh",
        [
          "-c",
          `set -eu
${runtimePromotion}
cd "$FIXTURE"
mkdir versions versions/1.2.3 staging
printf '1.2.3\\n' > versions/1.2.3/.install-complete
printf '1.2.3\\n' > staging/.install-complete
cat > versions/1.2.3/t3 <<'SCRIPT'
#!/bin/sh
# The process exits but a worker that ignores TERM retains stdout.
if [ -f "$FIXTURE/probe-started" ]; then exit 78; fi
: > "$FIXTURE/probe-started"
(sh -c 'trap "" TERM; /bin/sleep 4; echo late > "$FIXTURE/finished"') &
echo 't3 v1.2.3'
SCRIPT
printf '%s\\n' '#!/bin/sh' 'echo "t3 v1.2.3"' > staging/t3
touch staging/replacement
chmod +x versions/1.2.3/t3 staging/t3
# Exercise the production deadline with a shorter clock for this fixture.
production_timeout=\${t3_probe_timeout:-}
t3_probe_timeout=1
trap t3_release_lock EXIT
t3_acquire_lock "$FIXTURE/versions" 1.2.3 2
t3_promote_runtime "$FIXTURE/staging"
printf '%s' "$production_timeout"
`,
        ],
        { encoding: "utf8", env: { ...process.env, FIXTURE: tmp }, timeout: 10_000 },
      );
      expect(result.error).toBe(undefined);
      expect(result.status, result.stderr).toBe(0);
      expect(await NodeFSP.readdir(NodePath.join(tmp, "versions"))).toEqual(["1.2.3"]);
      expect(
        await NodeFSP.readdir(NodePath.join(tmp, "versions/1.2.3")),
        "the stalled runtime was reused",
      ).toContain("replacement");
      expect(result.stdout).toBe("30");
      await expect(NodeFSP.stat(NodePath.join(tmp, "finished"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  },
);

/** The launcher install.sh, `t3 install`, and `t3 update` write; exec by absolute path. */
const launcherScript = (executable: string) =>
  `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer home", () => {
  it("installs a relative home from a directory ending in a newline", async () => {
    const temporaryRoot = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-home-")),
    );
    const root = NodePath.join(temporaryRoot, "cwd\n");
    const homeName = "-custom home\\home\n";
    const home = NodePath.join(root, homeName);
    const version = "1.2.3";
    const target = NodePath.join(home, "runtime/versions", version);
    const launcher = NodePath.join(root, "bin/t3");
    try {
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await NodeFSP.writeFile(NodePath.join(target, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const install = () =>
        NodeChildProcess.spawnSync("sh", [NodePath.resolve(import.meta.dirname, "install.sh")], {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            T3CODE_HOME: homeName,
            T3CODE_VERSION: version,
            T3CODE_INSTALL_BIN_DIR: NodePath.dirname(launcher),
            T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:1",
          },
          encoding: "utf8",
        });
      // The second run replaces the launcher the first wrote, newlines in its path and all.
      const first = install();
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const { status, stdout, stderr } = install();
      expect(status, stdout + stderr).toBe(0);
      expect(stderr).toContain(`Installed T3.CodeShip ${version}`);
      expect(await NodeFSP.readFile(launcher, "utf8")).toBe(
        launcherScript(NodePath.join(target, "t3")),
      );
      expect(
        NodeChildProcess.execFileSync(launcher, ["--version"], {
          cwd: NodeOS.tmpdir(),
          encoding: "utf8",
        }).trim(),
      ).toBe("t3 v1.2.3");
    } finally {
      await NodeFSP.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3", "pingdotgg/t3code", 0],
    ["preview", "1.2.4-preview.20261019.50", "pingdotgg/t3code", 0],
    ["stable", "1.2.3", "GigaZoro/CodeShip", 0],
    // regression: #32897
    ["stable", "1.2.3", "pingdotgg/t3code", 1],
    ["stable", "1.2.3", "GigaZoro/CodeShip", 1],
  ])(
    "finds the newest %s release behind a full page of nightlies (%s, %s, %i HTTP 504s)",
    async (channel, version, repository, failures) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
      const target = NodePath.join(root, "home/runtime/versions", version);
      const server = NodeHttp.createServer((request, response) => {
        if (failures-- > 0) return response.writeHead(504).end();
        const url = new URL(request.url ?? "/", "http://fixture");
        const body =
          url.pathname === `/${repository}/releases/latest` &&
          request.headers.accept === "application/json"
            ? { tag_name: "v1.2.3" }
            : url.pathname === `/repos/${repository}/releases`
              ? { "1": nightlies, "2": [{ tag_name: `v${version}` }, { tag_name: "v1.2.3" }] }[
                  url.searchParams.get("page") ?? ""
                ]
              : undefined;
        if (body === undefined) response.statusCode = 404;
        // The API pretty-prints and the installer reads it line by line.
        response.end(JSON.stringify(body ?? [], null, 2));
      });
      try {
        // An existing completed install isolates release resolution from archive downloads.
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
        await NodeFSP.writeFile(NodePath.join(target, "t3"), `#!/bin/sh\necho "t3 v${version}"\n`, {
          mode: 0o755,
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
        const origin = `http://127.0.0.1:${address.port}`;
        const source = await NodeFSP.readFile(
          NodePath.resolve(import.meta.dirname, "install.sh"),
          "utf8",
        );
        const installer = NodePath.join(root, "install.sh");
        await NodeFSP.writeFile(
          installer,
          source.replace(/https:\/\/(api\.)?github\.com/g, origin),
        );
        const { code, output } = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = NodeChildProcess.spawn("sh", [installer], {
              env: {
                ...process.env,
                T3CODE_VERSION: "",
                T3CODE_CHANNEL: channel,
                T3CODE_RELEASE_REPOSITORY: repository,
                T3CODE_HOME: NodePath.join(root, "home"),
                T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                // A wrong version must fail here instead of downloading a real release.
                T3CODE_RELEASE_BASE_URL: origin,
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
          },
        );
        expect(code, output).toBe(0);
        expect(output).toContain(`Installed T3.CodeShip ${version}`);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

// regression: #35834
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "installer archive download",
  () => {
    it("names the archive when it returns 404", async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-archive-"));
      const arch = HostProcess.Architecture.defaultValue() === "arm64" ? "arm64" : "x64";
      const archive = `t3-1.2.3-linux-${arch}.tar.gz`;
      const server = NodeHttp.createServer((request, response) => {
        if (request.url === "/v1.2.3/SHA256SUMS")
          return response.end(`${"0".repeat(64)}  ${archive}\n`);
        response.writeHead(404).end();
      });
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
        const { code, output } = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = NodeChildProcess.spawn(
              "sh",
              [NodePath.resolve(import.meta.dirname, "install.sh")],
              {
                env: {
                  ...process.env,
                  T3CODE_CHANNEL: "",
                  T3CODE_VERSION: "1.2.3",
                  T3CODE_HOME: NodePath.join(root, "home"),
                  T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                  T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, output }));
          },
        );
        expect(code, output).not.toBe(0);
        expect(output).toMatch(new RegExp(`t3 install: .*${archive.replaceAll(".", "\\.")}`));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  },
);

/** Runs an installer for a version that is already unpacked, so only the t3 command step runs. */
async function installOver(input: {
  readonly script: "install.sh" | "install.ps1";
  readonly home: string;
  readonly binDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}) {
  const target = NodePath.join(input.home, "runtime", "versions", "1.2.3");
  await NodeFSP.mkdir(target, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), "1.2.3\n");
  const installer = NodePath.resolve(import.meta.dirname, input.script);
  const [command, args] =
    input.script === "install.sh"
      ? ["sh", [installer]]
      : ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]];
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: {
      ...process.env,
      T3CODE_CHANNEL: "",
      T3CODE_VERSION: "1.2.3",
      T3CODE_HOME: input.home,
      T3CODE_INSTALL_BIN_DIR: input.binDir,
      T3CODE_RELEASE_BASE_URL: "http://127.0.0.1:9",
      ...input.env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, target };
}

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("install.sh t3 command", () => {
  it("replaces only this home's own launchers and prints a PATH command", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-link-"));
    try {
      const home = NodePath.join(root, "home");
      const binDir = NodePath.join(root, "bin");
      const link = NodePath.join(binDir, "t3");
      await NodeFSP.mkdir(binDir, { recursive: true });

      await NodeFSP.writeFile(link, "#!/bin/sh\necho mine\n");
      const foreign = await installOver({ script: "install.sh", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain(`another t3 is already at ${link}`);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");
      // Not even from inside the versions folder, where `.` would resolve into it.
      const fromVersions = await installOver({
        script: "install.sh",
        home,
        binDir,
        cwd: foreign.target,
      });
      expect(fromVersions.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe("#!/bin/sh\necho mine\n");

      // A link that only looks like it points into versions (join() would normalize the ..).
      await NodeFSP.rm(link);
      await NodeFSP.mkdir(NodePath.join(home, "other"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(home, "other/t3"), "#!/bin/sh\n");
      await NodeFSP.symlink(`${home}/runtime/versions/../../other/t3`, link);
      const climbing = await installOver({ script: "install.sh", home, binDir });
      expect(climbing.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(`${home}/runtime/versions/../../other/t3`);

      // Only `<version>/t3` counts, not another program inside a version.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/helper"), link);
      const sibling = await installOver({ script: "install.sh", home, binDir });
      expect(sibling.code).not.toBe(0);
      expect(await NodeFSP.readlink(link)).toBe(
        NodePath.join(home, "runtime/versions/1.0.0/helper"),
      );

      // An upgrade over an older version's link, written through a symlinked T3 home.
      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "runtime/versions/1.0.0/t3"), link);
      await NodeFSP.symlink(home, NodePath.join(root, "alias"));
      const upgrade = await installOver({
        script: "install.sh",
        home: NodePath.join(root, "alias"),
        binDir,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(
        launcherScript(NodePath.join(root, "alias/runtime/versions/1.2.3/t3")),
      );
      expect(upgrade.output).toContain(
        `printf '\\n%s\\n' 'export PATH="$PATH:$HOME/bin"' >> ~/.zshrc`,
      );

      // Containers and CI often have no SHELL; `set -u` must not stop the installer there.
      const noShell = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, SHELL: undefined, PATH: "/usr/bin:/bin" },
      });
      expect(noShell.code, noShell.output).toBe(0);
      expect(noShell.output).toContain(`Add ${binDir} to your PATH`);

      // Its folder on PATH with a trailing slash is still this t3, not another one.
      const slashed = await installOver({
        script: "install.sh",
        home,
        binDir,
        env: { HOME: root, PATH: `${binDir}/:/usr/bin:/bin` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain("Run t3 to use T3.CodeShip here");

      // A relative folder is made absolute, so the PATH command never follows the working directory.
      const relative = await installOver({
        script: "install.sh",
        home,
        binDir: "bin",
        cwd: root,
        env: { HOME: root, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
      });
      expect(relative.code, relative.output).toBe(0);
      expect(relative.output).toContain(`'export PATH="$PATH:$HOME/bin"'`);

      // A launcher script someone edited is theirs now.
      const edited = `${launcherScript(NodePath.join(home, "runtime/versions/1.2.3/t3"))}# mine\n`;
      await NodeFSP.writeFile(link, edited);
      const overEdited = await installOver({ script: "install.sh", home, binDir });
      expect(overEdited.code).not.toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(edited);

      await NodeFSP.rm(link);
      await NodeFSP.symlink(NodePath.join(home, "bin/t3"), link);
      const overDesktop = await installOver({
        script: "install.sh",
        home: `${home}//`,
        binDir: `${binDir}/`,
      });
      expect(overDesktop.code, overDesktop.output).toBe(0);
      expect(await NodeFSP.readFile(link, "utf8")).toBe(
        launcherScript(NodePath.join(home, "runtime/versions/1.2.3/t3")),
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("install.ps1 t3 command", () => {
  it("replaces only its own t3.cmd, also in non-ASCII and bracketed paths", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-ps1-"));
    try {
      // Windows PowerShell 5.1 reads files as ANSI by default and expands wildcards in paths.
      const home = NodePath.join(root, "José", ".t3");
      const binDir = NodePath.join(root, "bin[t3]");
      const shim = NodePath.join(binDir, "t3.cmd");
      await NodeFSP.mkdir(binDir, { recursive: true });

      const desktopShim = '@echo off\r\n"C:\\Program Files\\T3 Code\\T3 Code.exe" "x" %*\r\n';
      await NodeFSP.writeFile(shim, desktopShim);
      const foreign = await installOver({ script: "install.ps1", home, binDir });
      expect(foreign.code).not.toBe(0);
      expect(foreign.output).toContain("another t3 is already at");
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(desktopShim);

      // A hand-edited wrapper may set its own environment; replacing it would drop that.
      const edited = `@echo off\r\nset "T3CODE_HOME=D:\\other"\r\n"${NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe")}" %*`;
      await NodeFSP.writeFile(shim, edited, "utf8");
      const wrapper = await installOver({ script: "install.ps1", home, binDir });
      expect(wrapper.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(edited);

      const climbing = `@echo off\r\n"${NodePath.join(home, "runtime", "versions")}\\..\\other\\t3.exe" %*`;
      await NodeFSP.writeFile(shim, climbing, "utf8");
      const outside = await installOver({ script: "install.ps1", home, binDir });
      expect(outside.code).not.toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toBe(climbing);

      const older = NodePath.join(home, "runtime", "versions", "1.0.0", "t3.exe");
      await NodeFSP.writeFile(shim, `@echo off\r\n"${older}" %*`, "utf8");
      const upgrade = await installOver({ script: "install.ps1", home, binDir });
      expect(upgrade.code, upgrade.output).toBe(0);
      expect(await NodeFSP.readFile(shim, "utf8")).toContain(
        NodePath.join(upgrade.target, "t3.exe"),
      );

      const again = await installOver({ script: "install.ps1", home, binDir });
      expect(again.code, again.output).toBe(0);

      // Another t3 first on PATH still runs, so the installer names this one in full.
      const otherBin = NodePath.join(root, "other");
      await NodeFSP.mkdir(otherBin);
      await NodeFSP.writeFile(NodePath.join(otherBin, "t3.cmd"), "@echo off\r\n");
      // Windows spells it Path; a second PATH key would be ambiguous.
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      const shadowed = await installOver({
        script: "install.ps1",
        home,
        binDir,
        env: { [pathKey]: `${otherBin};${process.env[pathKey] ?? ""}` },
      });
      expect(shadowed.code, shadowed.output).toBe(0);
      expect(shadowed.output).toContain(
        `Another t3 at ${NodePath.join(otherBin, "t3.cmd")} runs first`,
      );

      // Its own folder on PATH with a trailing separator is already on PATH.
      const slashed = await installOver({
        script: "install.ps1",
        home,
        binDir,
        env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
      });
      expect(slashed.code, slashed.output).toBe(0);
      expect(slashed.output).toContain("to use T3.CodeShip here");
      // The same when the install folder itself is given with a trailing separator.
      const bothSlashed = await installOver({
        script: "install.ps1",
        home,
        binDir: `${binDir}\\`,
        env: { [pathKey]: `${binDir}\\;${process.env[pathKey] ?? ""}` },
      });
      expect(bothSlashed.code, bothSlashed.output).toBe(0);
      expect(bothSlashed.output).toContain("to use T3.CodeShip here");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "timeout",
            "setsid",
            "uname",
            "tar",
            "gzip",
            "cut",
            "awk",
            "curl",
            "grep",
            "mkdir",
            "mktemp",
            "rmdir",
            "cat",
            "rm",
            "mv",
            "ln",
            "chmod",
            "sed",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            "#!/bin/sh\necho 't3 v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          server.on("request", (request, response) => {
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn(
                "sh",
                [NodePath.resolve(import.meta.dirname, "install.sh")],
                {
                  env: {
                    ...process.env,
                    PATH: tools,
                    T3CODE_VERSION: version,
                    T3CODE_HOME: home,
                    T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                    T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                  },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3 v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed T3.CodeShip");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

it.runIf(isDarwinHost || isLinuxHost)(
  "restores a damaged same-version install from the verified archive",
  () => verifyBundledRuntimeRepair(),
);

// regression: #38234
describe.runIf(
  isLinuxHost || (isDarwinHost && HostProcess.Architecture.defaultValue() === "arm64"),
)("concurrent installers", () => {
  it("publishes one runtime without nesting the other install's staging directory", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-concurrent-"));
    const version = "1.2.3";
    const stem = `t3-${version}-${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`;
    const archiveName = `${stem}.tar.gz`;
    const target = NodePath.join(root, "home/runtime/versions", version);
    const waiting: NodeHttp.ServerResponse[] = [];
    let archiveRequests = 0;
    const server = NodeHttp.createServer();
    try {
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      const archivePath = NodePath.join(root, archiveName);
      NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
      const archive = await NodeFSP.readFile(archivePath);
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      server.on("request", (request, response) => {
        if (request.url?.startsWith("/ready/")) {
          waiting.push(response);
          if (waiting.length === 2) {
            for (const ready of waiting) ready.end("go");
          }
        } else {
          if (request.url?.endsWith(archiveName)) archiveRequests++;
          response.end(
            request.url?.endsWith("/SHA256SUMS") ? `${digest}  ${archiveName}\n` : archive,
          );
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      // Release both installer processes together, before either can claim the runtime.
      const install = (id: string) =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "sh",
            [
              "-c",
              'curl -fsS "$1/ready/$2" >/dev/null && exec sh "$3"',
              "concurrent-installer",
              origin,
              id,
              NodePath.join(import.meta.dirname, "install.sh"),
            ],
            {
              env: {
                ...process.env,
                HOME: root,
                T3CODE_VERSION: version,
                T3CODE_HOME: NodePath.join(root, "home"),
                T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin", id),
                T3CODE_RELEASE_BASE_URL: origin,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
      const results = await Promise.all([install("first"), install("second")]);
      for (const result of results) expect(result.code, result.output).toBe(0);
      expect(archiveRequests).toBe(1);
      expect(
        (await NodeFSP.readdir(target)).filter((name) => name.startsWith(".staging-")),
        "concurrent installs must not leave a nested runtime",
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
