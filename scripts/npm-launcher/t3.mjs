#!/usr/bin/env node
// Share the installer's runtime cache; pre-0.0.41 services re-enter here over IPC.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchesCliVersion } from "./cliVersionProbe.mjs";
import { trackRuntimeDirectory } from "./runtimeDirectoryIdentity.mjs";

const { version } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
);

const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
// Well inside launchd's 20 s ExitTimeOut, which SIGKILLs only the launcher and orphans the runtime.
const TERMINATE_GRACE_MS = 5_000;

function t3Home() {
  const raw = (process.env.T3CODE_HOME || "").trim();
  if (raw === "") return path.join(os.homedir(), ".t3");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

const isTransient = (status) => status === 408 || status === 429 || status >= 500;

async function get(url) {
  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(url);
      if (attempt === 4 || !isTransient(response.status)) break;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function download(url, file) {
  const response = await get(url);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Kt3: downloading T3.CodeShip ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

async function install(dir, key, repairMarkedRuntime) {
  const archive = `t3-${version}-${key}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = (
    process.env.T3CODE_RELEASE_BASE_URL || "https://github.com/pingdotgg/t3code/releases/download"
  ).replace(/\/+$/, "");
  const sums = await (await get(`${base}/v${version}/SHA256SUMS`)).text();
  const expected = /^([0-9a-f]{64})\s+\*?(.+)$/im;
  const line = sums
    .split(/\r?\n/)
    .map((l) => expected.exec(l.trim()))
    .find((m) => m && m[2] === archive);
  if (!line) throw new Error(`${archive} is not listed in the release's SHA256SUMS`);

  // Stage beside the destination and rename atomically to avoid half-installed versions.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    if ((await download(`${base}/v${version}/${archive}`, file)) !== line[1].toLowerCase()) {
      throw new Error(`checksum mismatch for ${archive}`);
    }
    // Windows' own tar.exe reads zip; a Git-for-Windows tar on PATH cannot.
    const tar =
      process.platform === "win32" ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
    const extract = spawnSync(tar, ["-xf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    const failure = versionProbeFailure(staging);
    if (failure)
      throw executableError(
        key,
        `the downloaded t3 ${version} runtime failed verification: ${failure}`,
      );
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir, repairMarkedRuntime);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const hasVersionMarker = (dir) => {
  let marker;
  try {
    const { O_RDONLY, O_NONBLOCK } = fs.constants;
    marker = fs.openSync(path.join(dir, ".install-complete"), O_RDONLY | (O_NONBLOCK ?? 0));
    return fs.fstatSync(marker).isFile() && fs.readFileSync(marker, "utf8").trim() === version;
  } catch {
    return false;
  } finally {
    if (marker !== undefined) fs.closeSync(marker);
  }
};

// POSIX repairs and recovery share the shell, SSH and service installers' claim.
function promotePosixRuntime(dir, staging) {
  const args = [path.join(import.meta.dirname, "promote-runtime.sh"), path.dirname(dir), version];
  if (staging !== undefined) args.push(staging);
  const result = spawnSync("/bin/sh", args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not install the local t3 ${version} runtime`);
  return result.stdout.trim() === "0";
}

function recheckRuntime(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = trackRuntimeDirectory(dir);
    const verified = hasVersionMarker(dir) && verifiesVersion(dir);
    if (current()) return verified;
  }
  throw new Error(`the local t3 ${version} installation changed repeatedly during verification`);
}

function verifiedPeer(dir, repairMarkedRuntime = false) {
  if (!hasVersionMarker(dir)) return false;
  if (recheckRuntime(dir)) return true;
  if (repairMarkedRuntime) return false;
  throw new Error(`the concurrently installed t3 ${version} runtime failed verification`);
}

/** Preserve a verified concurrent publication and repair an incomplete installation. */
function publish(staging, dir, repairMarkedRuntime) {
  try {
    fs.renameSync(staging, dir);
    return;
  } catch (error) {
    if (verifiedPeer(dir, repairMarkedRuntime)) return;
    if (!fs.existsSync(dir)) throw error;
  }
  if (process.platform !== "win32") {
    const publishedStaging = promotePosixRuntime(dir, staging);
    if (!publishedStaging && !verifiedPeer(dir))
      throw new Error(`the installed t3 ${version} runtime failed verification`);
    return;
  }
  const lock = `${dir}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `another t3 is installing ${version}. If none is running, delete ${lock} and try again.`,
      { cause: error },
    );
  }
  const stale = `${staging}.stale`;
  try {
    // A peer may have published between our marker check and taking the lock.
    if (verifiedPeer(dir, repairMarkedRuntime)) return;
    // Move it aside rather than deleting in place: once the folder is empty, a
    // peer's first rename can land in it.
    fs.renameSync(dir, stale);
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      if (!fs.existsSync(dir)) {
        fs.renameSync(stale, dir);
        throw error;
      }
      if (!verifiedPeer(dir)) throw error;
    }
    fs.rmSync(stale, { recursive: true, force: true });
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

const entryName = process.platform === "win32" ? "t3.exe" : "t3";

function versionProbeFailure(dir) {
  const probe = spawnSync(path.join(dir, entryName), ["--version"], {
    env: { ...process.env, T3CODE_VERIFY_INSTALL: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  if (!probe.error && matchesCliVersion(probe.status, probe.stdout, version)) return undefined;
  return (
    probe.error?.message ||
    probe.stderr?.trim() ||
    `failed verification for t3 ${version}: ${probe.stdout?.trim() || probe.signal || probe.status}`
  );
}

function verifiesVersion(dir) {
  return versionProbeFailure(dir) === undefined;
}

function recoverPrevious(dir) {
  const parent = path.dirname(dir);
  const previous = path.join(parent, `.${version}.previous`);
  if (!hasVersionMarker(previous) || !recheckRuntime(previous)) return;
  if (process.platform === "win32") {
    try {
      fs.renameSync(previous, dir);
    } catch (error) {
      if (!fs.existsSync(dir)) throw error;
    }
  } else {
    promotePosixRuntime(dir);
  }
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.includes(key)) {
    throw new Error(
      `no T3.CodeShip CLI build is available for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        "The desktop app is at https://github.com/pingdotgg/t3code/releases",
    );
  }
  const dir = path.join(t3Home(), "runtime", "versions", version);
  const cached = hasVersionMarker(dir);
  if (!cached) recoverPrevious(dir);
  // A peer can restore a marked tree while recovery is reading the rollback.
  const marked = cached || hasVersionMarker(dir);
  if (!marked) {
    await install(dir, key, false);
  } else if (!recheckRuntime(dir)) {
    await install(dir, key, true);
  }

  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const child = spawn(path.join(dir, entryName), process.argv.slice(2), {
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    // The executable lives in the T3 home, so this is how it knows npm launched it.
    env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: import.meta.filename },
  });
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  let force;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!ipc && signal === "SIGINT") return;
      child.kill(signal);
      force ??= setTimeout(() => killTree(child), TERMINATE_GRACE_MS).unref();
    });
  }
  child.on("error", (error) => fail(executableError(key, error.message)));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

/** SIGKILL the runtime and its providers, which a runtime stuck on shutdown never stops. */
function killTree(child) {
  const pids = [child.pid];
  if (process.platform !== "win32") {
    const table =
      spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2_000 }).stdout ||
      "";
    const rows = table
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    for (let i = 0; i < pids.length; i++) {
      for (const [pid, ppid] of rows) if (ppid === pids[i]) pids.push(pid);
    }
  }
  for (const pid of pids.slice(1)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  child.kill("SIGKILL");
}

function executableError(key, detail) {
  return new Error(
    `could not run T3.CodeShip ${version} for ${key}: ${detail}` +
      (process.platform === "linux"
        ? "\nThe Linux release requires glibc; musl-based systems such as Alpine are not supported. Use a glibc-based Linux environment."
        : ""),
  );
}

function fail(error) {
  process.stderr.write(`t3: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
