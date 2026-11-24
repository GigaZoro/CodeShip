// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { isProcessAlive } from "../packages/shared/src/processProbe.ts";
import {
  configureWorktreePrepare,
  hasSetupEntry,
  installWorktreeDependencies,
  setupCheckout,
  setupStatus,
} from "./lib/install-worktree-dependencies.ts";
import {
  hasSetupDone,
  hasSetupOnlyStatus,
  matchesSetupFiles,
  readSetupProof,
  setupEnvFiles,
  setupEnvTarget,
  setupFileStamp,
  setupProofName,
  writeSetupProof,
} from "./lib/worktree-setup-proof.ts";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Setup runs before workspace dependencies are available.
const isWindows = NodeOS.platform() === "win32";
const worktree = NodeFS.realpathSync(NodePath.dirname(import.meta.dirname));
const markerDir = NodePath.join(worktree, ".t3");
const runningMarker = NodePath.join(markerDir, "setup-running");
const doneMarker = NodePath.join(markerDir, "setup-done");
const failedMarker = NodePath.join(markerDir, "setup-failed");
const inPlaceMarker = NodePath.join(markerDir, "setup-install-in-place");
const claimName = `setup-owner-${process.pid}`;
const claim = NodePath.join(markerDir, claimName);
const staging = NodePath.join(markerDir, "setup-stage");

const alive = (pid: number) => {
  if ((pid | 0) !== pid || pid <= 0) throw new Error("Unrecognized setup process");
  return isProcessAlive(pid);
};

const readMarker = (file: string, limit: number) => {
  const stat = NodeFS.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
    throw new Error(`Unrecognized setup marker: ${file}`);
  return NodeFS.readFileSync(file, "utf8");
};

const clearClaim = (directory: string) => {
  const stat = NodeFS.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  if (
    !stat.isDirectory() ||
    stat.uid !== NodeFS.lstatSync(markerDir).uid ||
    (!isWindows && (stat.mode & 0o077) !== 0)
  )
    throw new Error(`Unrecognized setup owner: ${directory}`);
  for (const name of NodeFS.readdirSync(directory)) {
    const file = NodePath.join(directory, name);
    const entry = NodeFS.lstatSync(file);
    if (
      isWindows ||
      (name !== "proof" && name !== "done") ||
      !entry.isFile() ||
      entry.uid !== stat.uid ||
      entry.size > 128 * 1024
    )
      throw new Error(`Unrecognized setup owner file: ${file}`);
    NodeFS.unlinkSync(file);
  }
  NodeFS.rmdirSync(directory);
};

let cancelSignal: NodeJS.Signals | undefined;
let activeInstall: NodeChildProcess.ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cancelSignal = signal;
    activeInstall?.kill(signal);
  });
}
const requireActive = () => {
  if (cancelSignal) throw new Error(`Cancelled by ${cancelSignal}.`);
};

const install = async (cwd: string) => {
  requireActive();
  // Closed stdin and --yes keep pnpm unattended. The shell also handles Windows vp shims.
  const child = NodeChildProcess.spawn("vp i --frozen-lockfile -- --yes", {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, T3CODE_WORKTREE_PATH: cwd },
  });
  activeInstall = child;
  let output = "";
  for (const [source, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    source.setEncoding("utf8");
    source.on("data", (chunk: string) => {
      target.write(chunk);
      output = (output + chunk).slice(-8_000);
    });
  }
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    requireActive();
    if (status !== 0) throw new Error(output.trimEnd().split("\n").slice(-30).join("\n"));
  } finally {
    activeInstall = undefined;
  }
};

const installInPlace = async () => {
  await NodeFSP.writeFile(inPlaceMarker, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try {
    await install(worktree);
  } finally {
    if (readMarker(inPlaceMarker, 32) === `${process.pid}\n`) await NodeFSP.unlink(inPlaceMarker);
  }
};

const linkEnvFiles = async (project: string) => {
  const links: Array<{ name: string; stamp: string }> = [];
  for (const name of setupEnvFiles) {
    const source = await setupEnvTarget(project, name);
    if (!source) continue;
    const target = NodePath.join(worktree, name);
    const parent = NodePath.dirname(target);
    if ((await NodeFSP.realpath(parent).catch(() => null)) !== parent) continue;
    try {
      await NodeFSP.symlink(source, target, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    links.push({ name, stamp: setupFileStamp(await NodeFSP.lstat(target, { bigint: true })) });
  }
  return links;
};

const warnAboutStore = () => {
  const modules = NodePath.join(worktree, "node_modules");
  const storeDir: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(modules, ".modules.yaml"), "utf8"),
  ).storeDir;
  if (
    typeof storeDir === "string" &&
    NodeFS.statSync(storeDir).dev !== NodeFS.statSync(modules).dev
  ) {
    process.stderr.write(
      [
        "",
        "WARNING: the pnpm store is on a different filesystem than this worktree.",
        `  store:    ${storeDir}`,
        `  worktree: ${worktree}`,
        "pnpm cannot hardlink or clone across filesystems, so it copied every package into node_modules.",
        "Fix: put the store on the worktree's filesystem, for example:",
        `  pnpm config set store-dir ${JSON.stringify(NodePath.join(NodePath.dirname(worktree), ".pnpm-store"))} --global`,
        "",
        "",
      ].join("\n"),
    );
  }
};

const publishDone = (marker: string) => {
  if (marker === "") {
    NodeFS.writeFileSync(doneMarker, marker, { flag: "wx" });
    return;
  }
  const pending = NodePath.join(claim, "done");
  NodeFS.writeFileSync(pending, marker, { flag: "wx" });
  NodeFS.linkSync(pending, doneMarker);
  NodeFS.unlinkSync(pending);
};

const setup = async () => {
  const project = process.env.T3CODE_PROJECT_ROOT;
  if (!project)
    throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
  const projectRoot = await NodeFSP.realpath(project);

  NodeFS.mkdirSync(markerDir, { recursive: true });
  if (!NodeFS.lstatSync(markerDir).isDirectory())
    throw new Error("Setup marker directory is redirected");
  // Register before checking peers. A simultaneous contender either sees us or makes both back off.
  NodeFS.mkdirSync(claim, { mode: 0o700 });
  let running = false;
  try {
    for (const name of NodeFS.readdirSync(markerDir)) {
      if (name === claimName) continue;
      const owner = /^setup-owner-([1-9]\d*)$/.exec(name);
      if (!owner) continue;
      if (alive(Number(owner[1]))) throw new Error("Another worktree setup is running");
      clearClaim(NodePath.join(markerDir, name));
    }
    const previous = readMarker(runningMarker, 32);
    if (previous !== undefined && (!/^[1-9]\d*\n$/.test(previous) || alive(Number(previous))))
      throw new Error("Another worktree setup may still be running");
    if (await hasSetupEntry(inPlaceMarker))
      throw new Error(
        "An interrupted in-place install may still be writing. Verify it has stopped before clearing its marker.",
      );

    const context = isWindows ? null : await setupCheckout(worktree, projectRoot);
    const checkout = setupFileStamp(
      await NodeFSP.lstat(NodePath.join(worktree, ".git"), { bigint: true }),
    );
    const priorProof = context && (await readSetupProof(context.admin, projectRoot, checkout));
    const previousDone = readMarker(doneMarker, 128);
    if (previousDone !== undefined && previousDone !== "" && previousDone !== priorProof?.marker)
      throw new Error("Unrecognized setup success marker");
    const previousFailure = readMarker(failedMarker, 64 * 1024);
    if (previousFailure !== undefined && !/^Setup exited with code \d+\./.test(previousFailure))
      throw new Error("Unrecognized setup failure marker");

    if (previous !== undefined) NodeFS.unlinkSync(runningMarker);
    if (previousFailure !== undefined) NodeFS.unlinkSync(failedMarker);
    NodeFS.writeFileSync(runningMarker, `${process.pid}\n`, { flag: "wx" });
    running = true;
    if (context && priorProof) {
      const sameFiles = await matchesSetupFiles(
        priorProof,
        worktree,
        AbortSignal.timeout(600_000),
      ).catch(() => false);
      if (
        sameFiles &&
        context.head === priorProof.head &&
        hasSetupOnlyStatus(priorProof, setupStatus(worktree)) &&
        !(await hasSetupEntry(staging))
      ) {
        requireActive();
        if (!(await hasSetupDone(doneMarker, priorProof.marker))) {
          if (previousDone !== undefined) NodeFS.unlinkSync(doneMarker);
          publishDone(priorProof.marker);
        }
        return;
      }
      if (!sameFiles) {
        for (const name of Object.keys(priorProof.modules)) {
          if (await hasSetupEntry(NodePath.join(worktree, name)))
            throw new Error(
              "Installed files changed since setup. Resolve local changes before reinstalling.",
            );
        }
      }
    }
    if (previousDone !== undefined) NodeFS.unlinkSync(doneMarker);
    if (context && priorProof) await NodeFSP.unlink(NodePath.join(context.admin, setupProofName));
    const modules =
      context && (await installWorktreeDependencies(worktree, context.head, staging, install));
    if (modules) await configureWorktreePrepare(worktree);
    else await installInPlace();
    requireActive();
    warnAboutStore();
    const links = await linkEnvFiles(projectRoot);
    const marker = context && modules ? NodeCrypto.randomUUID() + "\n" : "";
    if (context && modules) {
      await writeSetupProof(context.admin, NodePath.join(claim, "proof"), {
        root: projectRoot,
        checkout,
        head: context.head,
        marker,
        modules,
        links,
      });
    }
    requireActive();
    publishDone(marker);
  } catch (error) {
    if (running && !NodeFS.lstatSync(doneMarker, { throwIfNoEntry: false })) {
      const detail = error instanceof Error ? error.message : String(error);
      NodeFS.writeFileSync(failedMarker, `Setup exited with code 1.\n${detail.slice(-8_000)}\n`, {
        flag: "wx",
      });
    }
    throw error;
  } finally {
    if (running && readMarker(runningMarker, 32) === `${process.pid}\n`)
      NodeFS.unlinkSync(runningMarker);
    clearClaim(claim);
  }
};

await setup();
