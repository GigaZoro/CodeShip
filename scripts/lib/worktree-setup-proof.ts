// @effect-diagnostics nodeBuiltinImport:off -- Setup runs before dependencies are installed.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { inspectPosixMetadata } from "./posix-worktree-metadata.ts";
import { windowsSetupHost } from "./windows-worktree-files.ts";

export const setupProofName = "t3-setup-proof-v1";
export const setupStageName = "setup-stage";
export const setupEnvFiles = [".env", "infra/relay/.env"] as const;
const digestPattern = /^[a-f0-9]{64}$/;
const maxProofBytes = 128 * 1024;
// Bit positions are stored in the proof. Keep this order stable.
const cacheNames = [".cache", ".vite", ".vite-temp", ".vitest-cache", ".astro"] as const;

type CacheSlots = Record<string, number>;
interface TreeScan {
  modules: Record<string, string>;
  cacheSlots: CacheSlots;
  additions: string[];
}

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
  cacheNames: readonly string[],
  cacheSlots: CacheSlots | "seal" | undefined,
  windows: boolean,
): TreeScan {
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

  const sameStat = (left: NodeFS.BigIntStats, right: NodeFS.BigIntStats) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size;
  let count = 0;
  let totalBytes = 0n;
  const buffer = Buffer.allocUnsafe(windows ? 64 * 1024 : 128 * 1024);
  const hashFile = (file: string, stat: NodeFS.BigIntStats) => {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      if (!sameStat(stat, fs.fstatSync(fd, { bigint: true })))
        throw new Error("Setup file changed before reading");
      const content = crypto.createHash("sha256");
      let remaining = Number(stat.size);
      while (remaining > 0) {
        const read = fs.readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null);
        if (read === 0) throw new Error("Setup file was truncated while reading");
        content.update(buffer.subarray(0, read));
        remaining -= read;
      }
      if (
        !sameStat(stat, fs.fstatSync(fd, { bigint: true })) ||
        !sameStat(stat, fs.lstatSync(file, { bigint: true }))
      )
        throw new Error("Setup file changed while reading");
      return content.digest("hex");
    } finally {
      fs.closeSync(fd);
    }
  };

  // NTFS hardlink aliases change a file's change time without touching its bytes, so a changed
  // stamp is settled by a second identical read instead of refused.
  const hashWindowsFile = (file: string, stat: NodeFS.BigIntStats) => {
    const fd = fs.openSync(file, "r");
    try {
      const snapshot = () => {
        const current = fs.fstatSync(fd, { bigint: true });
        if (
          !current.isFile() ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino ||
          current.birthtimeNs !== stat.birthtimeNs ||
          current.mtimeNs !== stat.mtimeNs ||
          current.size !== stat.size
        )
          throw new Error("Setup file changed while reading");
        return current.ctimeNs;
      };
      const readBytes = () => {
        const hash = crypto.createHash("sha256");
        let position = 0;
        while (true) {
          const bytes = fs.readSync(fd, buffer, { position });
          if (bytes === 0) break;
          position += bytes;
          if (BigInt(position) > stat.size) throw new Error("Setup file grew while reading");
          hash.update(buffer.subarray(0, bytes));
        }
        if (BigInt(position) !== stat.size) throw new Error("Setup file shrank while reading");
        return hash.digest("hex");
      };
      const before = snapshot();
      const digest = readBytes();
      const after = snapshot();
      if (stat.ctimeNs !== before || before !== after) {
        if (readBytes() !== digest || snapshot() !== after)
          throw new Error("Setup file changed while reading");
      }
      const present = fs.lstatSync(file, { bigint: true });
      if (
        !present.isFile() ||
        present.dev !== stat.dev ||
        present.ino !== stat.ino ||
        present.birthtimeNs !== stat.birthtimeNs ||
        present.mtimeNs !== stat.mtimeNs ||
        present.size !== stat.size
      )
        throw new Error("Setup file was replaced while reading");
      return digest;
    } finally {
      fs.closeSync(fd);
    }
  };

  const results: TreeScan = { modules: {}, cacheSlots: {}, additions: [] };
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
    const pending: Array<string | { file: string; stat: NodeFS.BigIntStats }> = [""];
    let slots = cacheSlots === "seal" ? 0 : (cacheSlots?.[name] ?? 0);
    while (pending.length) {
      const relative = pending.pop()!;
      if (typeof relative !== "string") {
        if (!sameStat(relative.stat, fs.lstatSync(relative.file, { bigint: true })))
          throw new Error("Setup directory changed while scanning");
        continue;
      }
      const file = path.join(base, relative);
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.ino === 0n || stat.ctimeNs <= 0n)
        throw new Error("Setup entry has no filesystem change stamp");
      // NTFS reports no POSIX owner or mode, and its change time moves with hardlink aliases.
      const stamp = windows
        ? [stat.dev, stat.ino, stat.birthtimeNs]
        : [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs];
      // A root's immediate child list is sealed by the digest. Root times and size can
      // change when a reserved cache is added or when setup publishes the root by rename.
      if (!cacheSlots || relative !== "") stamp.push(stat.mtimeNs, stat.size);
      if (!windows && relative !== "" && (!cacheSlots || !stat.isFile())) stamp.push(stat.ctimeNs);
      let link = "";
      if (stat.isDirectory()) {
        const children = fs.readdirSync(file).sort();
        if (cacheSlots) pending.push({ file, stat });
        if (relative === "" && cacheSlots === "seal") {
          for (const [index, cache] of cacheNames.entries()) {
            if (!children.includes(cache)) slots |= 1 << index;
          }
        }
        for (const child of children) {
          const index = relative === "" && slots !== 0 ? cacheNames.indexOf(child) : -1;
          if (index >= 0 && (slots & (1 << index)) !== 0) {
            const extra = fs.lstatSync(path.join(file, child), { bigint: true });
            if (!extra.isDirectory() || extra.ino === 0n || extra.ctimeNs <= 0n)
              throw new Error("Uninspectable setup cache");
            results.additions.push(name + "/" + child);
            continue;
          }
          if (!validPath(child)) throw new Error("Uninspectable setup entry");
          pending.push(relative === "" ? child : relative + "/" + child);
        }
      } else if (relative === "") {
        throw new Error("Setup output root is not a directory");
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file, { encoding: "buffer" });
        if (windows && !stagingPath) {
          const relativeTarget = path.relative(root, fs.realpathSync.native(file));
          if (
            relativeTarget === ".." ||
            relativeTarget.startsWith(".." + path.sep) ||
            path.isAbsolute(relativeTarget)
          )
            throw new Error("Dependency links outside the worktree");
        }
        if (stagingPath) {
          const value = target.toString("utf8");
          if (path.isAbsolute(value)) {
            const resolved = path.resolve(value);
            if (resolved === stagingPath || resolved.startsWith(stagingPath + path.sep))
              throw new Error("Dependency links to the private setup checkout");
          }
        }
        if (cacheSlots && !sameStat(stat, fs.lstatSync(file, { bigint: true })))
          throw new Error("Setup link changed while scanning");
        link = target.toString("base64");
      } else if (!stat.isFile()) {
        throw new Error("Setup output contains a special file");
      } else if (cacheSlots || windows) {
        // pnpm can add and remove store aliases at any time, changing a file's ctime.
        totalBytes += stat.size;
        if (stat.size > 512n * 1024n ** 2n || totalBytes > 16n * 1024n ** 3n)
          throw new Error("Setup output exceeds content scan limit");
        if (windows) link = hashWindowsFile(file, stat);
        else link = hashFile(file, stat);
      }
      tree.update(JSON.stringify([relative, stamp.join("/"), link]));
      count++;
      if (count + pending.length > 2_000_000) throw new Error("Setup output exceeds entry limit");
    }
    results.modules[name] = tree.digest("hex");
    results.cacheSlots[name] = slots;
  }
  return results;
};

const scanSetupTrees = (
  root: string,
  modules: readonly string[],
  signal?: AbortSignal,
  stagingPath?: string,
  cacheSlots?: CacheSlots | "seal",
) =>
  new Promise<TreeScan>((resolve, reject) => {
    signal?.throwIfAborted();
    // Keep synchronous filesystem calls off the event loop, including in the single-file CLI.
    const worker = new NodeWorkerThreads.Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const scan = (${scan.toString()});
        parentPort.postMessage(scan(workerData.root, workerData.modules, require("node:fs"), require("node:path"), require("node:crypto"), workerData.stagingPath, workerData.cacheNames, workerData.cacheSlots, workerData.windows));
      `,
      {
        eval: true,
        execArgv: [],
        workerData: {
          root,
          modules,
          stagingPath,
          cacheNames,
          cacheSlots,
          windows: windowsSetupHost,
        },
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

const inspectModuleMetadata = (root: string, slots: CacheSlots, signal: AbortSignal) =>
  inspectPosixMetadata(
    root,
    {
      modules: Object.fromEntries(
        Object.entries(slots).map(([name, mask]) => [
          name,
          cacheNames.filter((_, index) => (mask & (1 << index)) !== 0),
        ]),
      ),
    },
    signal,
  );

export const sealSetupMarkers = async (
  cwd: string,
  marker: "setup-running" | "setup-done",
  signal: AbortSignal,
) => (windowsSetupHost ? undefined : inspectPosixMetadata(cwd, { marker }, signal));

export const sealSetupTrees = async (
  root: string,
  modules: readonly string[],
  signal: AbortSignal,
  stagingPath?: string,
) => {
  const sealed = await scanSetupTrees(root, modules, signal, stagingPath, "seal");
  return {
    modules: sealed.modules,
    cacheSlots: sealed.cacheSlots,
    ...(!windowsSetupHost
      ? { posixMetadataV1: await inspectModuleMetadata(root, sealed.cacheSlots, signal) }
      : {}),
  };
};

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
  readonly cacheSlots?: CacheSlots;
  // Missing on legacy receipts and when this filesystem could not supply release evidence.
  readonly posixMetadataV1?: string | undefined;
  readonly markerMetadataV1?: string | undefined;
  // Setup installed these files in place, so no sealed copy vouches for them. The receipt only
  // lets a retry tell untouched output from changed files.
  readonly inPlace?: true;
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
    (proof.inPlace !== undefined && proof.inPlace !== true) ||
    ![proof.posixMetadataV1, proof.markerMetadataV1].every(
      (value) => value === undefined || (typeof value === "string" && digestPattern.test(value)),
    ) ||
    !proof.modules ||
    typeof proof.modules !== "object" ||
    !Object.hasOwn(proof.modules, "node_modules") ||
    !Object.entries(proof.modules).every(
      ([name, value]) =>
        modulePathPattern.test(name) && typeof value === "string" && digestPattern.test(value),
    ) ||
    (proof.cacheSlots !== undefined &&
      (!proof.cacheSlots ||
        Object.keys(proof.cacheSlots).length !== Object.keys(proof.modules).length ||
        !Object.keys(proof.modules).every((name) => {
          const slots = proof.cacheSlots?.[name];
          return (
            typeof slots === "number" &&
            Number.isInteger(slots) &&
            slots >= 0 &&
            slots < 1 << cacheNames.length
          );
        }))) ||
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

const inspectSetupFiles = async (proof: SetupProof, cwd: string, signal: AbortSignal) => {
  for (const { name, stamp } of proof.links) {
    const source = await setupEnvTarget(proof.root, name);
    const target = NodePath.join(cwd, name);
    if (!source || (await NodeFSP.realpath(NodePath.dirname(target))) !== NodePath.dirname(target))
      return null;
    const link = await NodeFSP.lstat(target, { bigint: true });
    if (
      !link.isSymbolicLink() ||
      setupFileStamp(link) !== stamp ||
      (await NodeFSP.readlink(target)) !== source
    )
      return null;
  }
  const modules = Object.keys(proof.modules);
  const current = await scanSetupTrees(cwd, modules, signal, undefined, proof.cacheSlots);
  if (!modules.every((name) => current.modules[name] === proof.modules[name])) return null;
  if (
    !windowsSetupHost &&
    proof.posixMetadataV1 !== undefined &&
    (await inspectModuleMetadata(cwd, current.cacheSlots, signal)) !== proof.posixMetadataV1
  )
    return null;
  return current.additions.sort();
};

export const matchesSetupFiles = async (proof: SetupProof, cwd: string, signal: AbortSignal) =>
  (await inspectSetupFiles(proof, cwd, signal))?.length === 0;

export const hasSetupDone = async (marker: string, expected: string) => {
  const stat = await NodeFSP.lstat(marker).catch(missingSetupPath);
  return (
    stat?.isFile() === true &&
    stat.nlink === 1 &&
    stat.size === expected.length &&
    (await NodeFSP.readFile(marker, "utf8")) === expected
  );
};

// Returned cache roots must be preserved and revalidated by the release caller.
export const inspectSetupProof = async (
  proof: SetupProof,
  cwd: string,
  status: string,
  signal: AbortSignal,
): Promise<readonly string[] | null> => {
  if (proof.inPlace || !hasSetupOnlyStatus(proof, status)) return null;
  const markerDir = NodePath.join(cwd, ".t3");
  if (!(await NodeFSP.lstat(markerDir)).isDirectory()) return null;
  const markers = await NodeFSP.readdir(markerDir);
  if (
    markers.length !== 1 ||
    markers[0] !== "setup-done" ||
    !(await hasSetupDone(NodePath.join(markerDir, "setup-done"), proof.marker))
  )
    return null;
  if (
    !windowsSetupHost &&
    (!proof.cacheSlots ||
      !proof.posixMetadataV1 ||
      !proof.markerMetadataV1 ||
      (await sealSetupMarkers(cwd, "setup-done", signal)) !== proof.markerMetadataV1)
  )
    return null;
  return inspectSetupFiles(proof, cwd, signal);
};

export const matchesSetupProof = async (
  proof: SetupProof,
  cwd: string,
  status: string,
  signal: AbortSignal,
) => (await inspectSetupProof(proof, cwd, status, signal))?.length === 0;
