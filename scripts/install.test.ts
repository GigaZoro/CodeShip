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

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3", "pingdotgg/t3code"],
    ["preview", "1.2.4-preview.20261019.50", "pingdotgg/t3code"],
    ["stable", "1.2.3", "GigaZoro/CodeShip"],
  ])(
    "finds the newest %s release behind a full page of nightlies (%s, %s)",
    async (channel, version, repository) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
      const target = NodePath.join(root, "home/runtime/versions", version);
      const server = NodeHttp.createServer((request, response) => {
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
