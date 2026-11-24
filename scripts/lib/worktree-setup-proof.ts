// @effect-diagnostics nodeBuiltinImport:off -- Setup runs before dependencies are installed.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { windowsSetupHost } from "./windows-worktree-files.ts";

export const setupProofName = "t3-setup-proof-v1";
export const setupEnvFiles = [".env", "infra/relay/.env"] as const;
const digestPattern = /^[a-f0-9]{64}$/;
const maxProofBytes = 128 * 1024;

export const missingSetupPath = (error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
};

export const setupFileStamp = (stat: NodeFS.BigIntStats) =>
  [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mode, stat.size].join("/");

const scan = function (
  root: string,
  modules: readonly string[],
  fs: typeof NodeFS,
  path: typeof NodePath,
  crypto: typeof import("node:crypto"),
  stagingPath: string | undefined,
  windows: boolean,
) {
  const validPath = (name: string) =>
    name.length > 0 &&
    !name.includes("\\") &&
    !name.includes("\uFFFD") &&
    !name.includes(":") &&
    name
      .split("/")
      .every(
        (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
      );

  const buffer = Buffer.allocUnsafe(windows ? 64 * 1024 : 0);
  let count = 0;
  const results: Record<string, string> = {};
  for (const name of modules) {
    if (!validPath(name) || !/(^|\/)node_modules$/.test(name))
      throw new Error("Invalid setup output path");
    const base = path.join(root, name);
    let parent = root;
    for (const segment of name.split("/").slice(0, -1)) {
      parent = path.join(parent, segment);
      if (!fs.lstatSync(parent).isDirectory())
        throw new Error("Setup output has a redirected parent");
    }
    const tree = crypto.createHash("sha256");
    const pending = [""];
    while (pending.length) {
      const relative = pending.pop()!;
      const file = path.join(base, relative);
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.ino === 0n || stat.ctimeNs <= 0n)
        throw new Error("Setup entry has no filesystem change stamp");
      const stamp = [stat.dev, stat.ino, stat.birthtimeNs, stat.mtimeNs, stat.size];
      if (!windows) stamp.splice(2, 0, stat.mode, stat.uid, stat.gid);
      // Renaming each pre-sealed root changes its ctime. The entries inside retain theirs.
      if (relative !== "" && !windows) stamp.push(stat.ctimeNs);
      let link = "";
      if (stat.isDirectory()) {
        const children = fs.readdirSync(file).sort();
        for (const child of children) {
          if (!validPath(child)) throw new Error("Uninspectable setup entry");
          pending.push(relative === "" ? child : relative + "/" + child);
        }
      } else if (relative === "") {
        throw new Error("Setup output root is not a directory");
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file, { encoding: "buffer" });
        if (stagingPath) {
          const value = target.toString("utf8");
          if (path.isAbsolute(value)) {
            const resolved = path.resolve(value);
            if (resolved === stagingPath || resolved.startsWith(stagingPath + path.sep))
              throw new Error("Dependency links to the private setup checkout");
          }
        }
        link = target.toString("base64");
      } else if (!stat.isFile()) {
        throw new Error("Setup output contains a special file");
      } else if (windows) {
        // NTFS hardlink changes can change the shared file's ctime without changing its bytes.
        const fd = fs.openSync(file, "r");
        try {
          const hash = crypto.createHash("sha256");
          let size = 0n;
          while (true) {
            const bytes = fs.readSync(fd, buffer);
            if (bytes === 0) break;
            size += BigInt(bytes);
            if (size > stat.size) throw new Error("Setup file grew while reading");
            hash.update(buffer.subarray(0, bytes));
          }
          const after = fs.fstatSync(fd, { bigint: true });
          if (
            size !== stat.size ||
            after.dev !== stat.dev ||
            after.ino !== stat.ino ||
            after.mtimeNs !== stat.mtimeNs ||
            after.ctimeNs !== stat.ctimeNs
          )
            throw new Error("Setup file changed while reading");
          link = hash.digest("hex");
        } finally {
          fs.closeSync(fd);
        }
      }
      tree.update(JSON.stringify([relative, stamp.join("/"), link]));
      count++;
      if (count + pending.length > 2_000_000) throw new Error("Setup output exceeds entry limit");
    }
    results[name] = tree.digest("hex");
  }
  return results;
};

export const setupTreeDigests = (
  root: string,
  modules: readonly string[],
  signal?: AbortSignal,
  stagingPath?: string,
) =>
  new Promise<Record<string, string>>((resolve, reject) => {
    signal?.throwIfAborted();
    // Keep synchronous filesystem calls off the event loop, including in the single-file CLI.
    const worker = new NodeWorkerThreads.Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const scan = (${scan.toString()});
        parentPort.postMessage(scan(workerData.root, workerData.modules, require("node:fs"), require("node:path"), require("node:crypto"), workerData.stagingPath, workerData.windows));
      `,
      {
        eval: true,
        execArgv: [],
        workerData: { root, modules, stagingPath, windows: windowsSetupHost },
      },
    );
    const abort = () => {
      void worker.terminate();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Setup proof scanner exited without a result (${code})`));
    });
  });

export const setupEnvTarget = async (projectRoot: string, name: string) => {
  const source = NodePath.join(projectRoot, name);
  if (
    (await NodeFSP.realpath(NodePath.dirname(source)).catch(() => null)) !==
    NodePath.dirname(source)
  )
    return undefined;
  return (await NodeFSP.lstat(source).catch(missingSetupPath))?.isFile() ? source : undefined;
};

interface SetupProof {
  readonly root: string;
  readonly checkout: string;
  readonly head: string;
  readonly marker: string;
  readonly modules: Record<string, string>;
  readonly links: ReadonlyArray<{ readonly name: string; readonly stamp: string }>;
}

const stampPattern = /^(?:\d+\/){5}\d+$/;
const markerPattern = /^[a-f0-9-]{36}\n$/;
const modulePathPattern = /^(?:[a-z0-9_-]+\/)*node_modules$/i;

export const readSetupProof = async (admin: string, projectRoot: string, checkout: string) => {
  const file = NodePath.join(admin, setupProofName);
  const stat = await NodeFSP.lstat(file, { bigint: true }).catch(missingSetupPath);
  if (!stat) return null;
  if (
    !stat.isFile() ||
    stat.ino === 0n ||
    stat.nlink !== 1n ||
    stat.size > maxProofBytes ||
    (!windowsSetupHost &&
      ((stat.mode & 0o077n) !== 0n ||
        stat.uid !== (await NodeFSP.lstat(admin, { bigint: true })).uid))
  )
    throw new Error("Unrecognized setup proof");
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  let proof: SetupProof;
  try {
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (
      BigInt(bytesRead) !== stat.size ||
      setupFileStamp(await handle.stat({ bigint: true })) !== setupFileStamp(stat)
    )
      throw new Error("Setup proof changed while reading");
    proof = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
  if (
    proof?.root !== projectRoot ||
    proof.checkout !== checkout ||
    typeof proof.head !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proof.head) ||
    typeof proof.marker !== "string" ||
    !markerPattern.test(proof.marker) ||
    !proof.modules ||
    typeof proof.modules !== "object" ||
    !Object.hasOwn(proof.modules, "node_modules") ||
    !Object.entries(proof.modules).every(
      ([name, value]) =>
        modulePathPattern.test(name) && typeof value === "string" && digestPattern.test(value),
    ) ||
    !Array.isArray(proof.links) ||
    proof.links.length > setupEnvFiles.length ||
    new Set(proof.links.map((link) => link?.name)).size !== proof.links.length ||
    !proof.links.every(
      (link) =>
        typeof link?.stamp === "string" &&
        stampPattern.test(link.stamp) &&
        setupEnvFiles.some((candidate) => candidate === link.name),
    )
  )
    throw new Error("Unrecognized setup proof");
  return proof;
};

export const writeSetupProof = async (admin: string, stagingFile: string, proof: SetupProof) => {
  const body = JSON.stringify(proof);
  if (Buffer.byteLength(body) > maxProofBytes) throw new Error("Setup proof exceeds size limit");
  await NodeFSP.writeFile(stagingFile, body, { flag: "wx", mode: 0o600 });
  const destination = NodePath.join(admin, setupProofName);
  if (await NodeFSP.lstat(destination).catch(missingSetupPath))
    throw new Error("Setup proof already exists");
  await NodeFSP.rename(stagingFile, destination);
};

export const hasSetupOnlyStatus = (proof: SetupProof, status: string) => {
  const paths = new Set([
    ".t3",
    ".t3/setup-done",
    ...Object.keys(proof.modules),
    ...proof.links.map((link) => link.name),
  ]);
  return status
    .split("\0")
    .every(
      (record) =>
        record === "" ||
        (record.startsWith("!! ") && paths.has(record.slice(3).replace(/\/$/, ""))),
    );
};

export const matchesSetupFiles = async (proof: SetupProof, cwd: string, signal: AbortSignal) => {
  for (const { name, stamp } of proof.links) {
    const source = await setupEnvTarget(proof.root, name);
    const target = NodePath.join(cwd, name);
    if (!source || (await NodeFSP.realpath(NodePath.dirname(target))) !== NodePath.dirname(target))
      return false;
    const link = await NodeFSP.lstat(target, { bigint: true });
    if (
      !link.isSymbolicLink() ||
      setupFileStamp(link) !== stamp ||
      (await NodeFSP.readlink(target)) !== source
    )
      return false;
  }
  const modules = Object.keys(proof.modules);
  const current = await setupTreeDigests(cwd, modules, signal);
  return modules.every((name) => current[name] === proof.modules[name]);
};

export const hasSetupDone = async (marker: string, expected: string) => {
  const stat = await NodeFSP.lstat(marker).catch(missingSetupPath);
  return (
    stat?.isFile() === true &&
    stat.nlink === 1 &&
    stat.size === expected.length &&
    (await NodeFSP.readFile(marker, "utf8")) === expected
  );
};

export const matchesSetupProof = async (
  proof: SetupProof,
  cwd: string,
  status: string,
  signal: AbortSignal,
) => {
  if (!hasSetupOnlyStatus(proof, status)) return false;
  const markerDir = NodePath.join(cwd, ".t3");
  if (!(await NodeFSP.lstat(markerDir)).isDirectory()) return false;
  const markers = await NodeFSP.readdir(markerDir);
  return (
    markers.length === 1 &&
    markers[0] === "setup-done" &&
    (await hasSetupDone(NodePath.join(markerDir, "setup-done"), proof.marker)) &&
    (await matchesSetupFiles(proof, cwd, signal))
  );
};
