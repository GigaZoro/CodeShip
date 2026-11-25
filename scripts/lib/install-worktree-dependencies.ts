// @effect-diagnostics nodeBuiltinImport:off -- Setup runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  checkWindowsWorktreeFiles,
  WindowsWorktreeInspectionError,
  windowsSetupHost,
} from "./windows-worktree-files.ts";
import { missingSetupPath, sealSetupTrees } from "./worktree-setup-proof.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trimEnd();

export const setupStatus = (cwd: string, ...paths: string[]) =>
  git(
    cwd,
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
    ...(paths.length ? ["--", ...paths] : []),
  );

export const hasSetupEntry = async (file: string) =>
  (await NodeFSP.lstat(file).catch(missingSetupPath)) !== undefined;

const prepareCommand = "node .github/scripts/release-notes.cjs configure";
const lifecycle = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
];

export const setupCheckout = async (worktree: string, project: string) => {
  const admin = await NodeFSP.realpath(git(worktree, "rev-parse", "--absolute-git-dir"));
  const common = await NodeFSP.realpath(
    git(project, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  if (
    NodePath.dirname(admin) !== NodePath.join(common, "worktrees") ||
    (await NodeFSP.realpath(git(project, "rev-parse", "--absolute-git-dir"))) !== common ||
    (await NodeFSP.realpath(git(project, "rev-parse", "--show-toplevel"))) !== project ||
    (await NodeFSP.stat(worktree)).dev !== (await NodeFSP.stat(admin)).dev
  )
    return null;
  const head = git(worktree, "rev-parse", "--verify", "HEAD");
  return { admin, head };
};

const cleanSetupInputs = (status: string) =>
  status
    .split("\0")
    .every(
      (record) =>
        record === "" ||
        record === "!! .t3/" ||
        /^!! \.t3\/setup-(?:running|done|stage\/|owner-[1-9]\d*)$/.test(record),
    );

const onlyAttemptMarkers = async (staging: string, owner: string, ownStage: boolean) => {
  const paths = await NodeFSP.readdir(NodePath.dirname(staging));
  return paths.every(
    (name) =>
      name === "setup-running" ||
      (windowsSetupHost ? name === owner : /^setup-owner-[1-9]\d*$/.test(name)) ||
      (ownStage && name === NodePath.basename(staging)),
  );
};

const stillAbsent = async (cwd: string, name: string) => {
  const dest = NodePath.join(cwd, name);
  return (
    (await NodeFSP.realpath(NodePath.dirname(dest))) === NodePath.dirname(dest) &&
    !(await hasSetupEntry(dest))
  );
};

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(file, "utf8"));

const relativeInside = (root: string, target: string) => {
  const relative = NodePath.relative(root, target);
  return relative === ".." ||
    relative.startsWith(".." + NodePath.sep) ||
    NodePath.isAbsolute(relative)
    ? undefined
    : relative;
};

const windowsLocalPath = (value: string) => value.replace(/^\\\\\?\\(?=[a-z]:\\)/i, "");

const windowsStagedPath = async (staged: string, value: string) => {
  const absolute = windowsLocalPath(value);
  if (!NodePath.isAbsolute(absolute)) return undefined;
  const normalized = NodePath.normalize(absolute);
  const resolved = await NodeFSP.realpath(normalized).catch(missingSetupPath);
  if (resolved !== undefined) return relativeInside(staged, resolved);
  const parent = NodePath.dirname(normalized);
  if (parent === normalized) return undefined;
  const resolvedParent = await NodeFSP.realpath(parent).catch(missingSetupPath);
  return resolvedParent === undefined
    ? relativeInside(staged, normalized)
    : relativeInside(staged, NodePath.join(resolvedParent, NodePath.basename(normalized)));
};

const workspaceManifests = async (cwd: string, tracked: readonly string[]) => {
  const source = await NodeFSP.readFile(NodePath.join(cwd, "pnpm-workspace.yaml"), "utf8").catch(
    missingSetupPath,
  );
  const lines = source?.match(/^packages:\r?\n((?:  - [^\r\n]+\r?\n)+)(?=\r?\n|[^ \t]|$)/m)?.[1];
  if (!lines) return null;
  const patterns = lines
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.slice(4));
  if (!patterns.every((pattern) => /^[a-z0-9-]+(?:\/\*)?$/.test(pattern))) return null;
  const folders = patterns.map((pattern) => pattern.split("/"));
  return tracked.filter((name) => {
    if (name === "package.json") return true;
    if (!name.endsWith("/package.json")) return false;
    const parts = name.split("/").slice(0, -1);
    return folders.some(
      (folder) =>
        folder.length === parts.length &&
        folder.every((part, index) => part === "*" || parts[index] === part),
    );
  });
};

const workspaceModuleRoots = (manifests: readonly string[]) =>
  new Set([
    "node_modules",
    ...manifests
      .filter((name) => name !== "package.json")
      .map((name) => name.slice(0, -"package.json".length) + "node_modules"),
  ]);

const localWorkspaceManifests = (cwd: string) => {
  const files = git(cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  return workspaceManifests(cwd, files);
};

const localInstallOverrides = [".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs", ".pnpmfile.js"];
const installManifests = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

export const windowsInstallInputsUnchanged = async (cwd: string, head: string) => {
  const manifests = await localWorkspaceManifests(cwd);
  if (!manifests) return false;
  const trackedInputs = [
    ...[...installManifests, ...localInstallOverrides].map((name) => `:(glob)**/${name}`),
    ":(glob)patches/**",
    ":(glob)**/*.tgz",
  ];
  if (
    git(cwd, "ls-files", "-v", "-z", "--", ...trackedInputs)
      .split("\0")
      .some((entry) => entry && !entry.startsWith("H "))
  )
    return false;
  if (
    git(
      cwd,
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "diff",
      "--no-textconv",
      "--no-ext-diff",
      "--name-only",
      "-z",
      head,
      "--",
      ...trackedInputs,
    )
  )
    return false;
  const workspaceFolders = new Set([
    ".",
    ...manifests.map((name) => name.slice(0, -"package.json".length)),
  ]);
  const possibleInputs = [...workspaceFolders].flatMap((folder) =>
    [...installManifests, ...localInstallOverrides].map((name) =>
      NodePath.posix.join(folder, name),
    ),
  );
  return setupStatus(cwd, ...possibleInputs, "patches", "apps/mobile/deps") === "";
};

export const windowsInstallTargetsSafe = async (cwd: string, verified: ReadonlySet<string>) => {
  const manifests = await localWorkspaceManifests(cwd);
  if (!manifests) return false;
  for (const name of workspaceModuleRoots(manifests)) {
    const target = NodePath.join(cwd, name);
    const parent = NodePath.dirname(target);
    const realParent = await NodeFSP.realpath(parent).catch(missingSetupPath);
    if (realParent === undefined) continue;
    if (realParent !== parent || (!verified.has(name) && (await hasSetupEntry(target))))
      return false;
  }
  return true;
};

export const inspectWindowsInPlaceModules = async (cwd: string) => {
  const manifests = await localWorkspaceManifests(cwd);
  if (!manifests) return null;
  const modules: string[] = [];
  for (const name of workspaceModuleRoots(manifests)) {
    const entry = await NodeFSP.lstat(NodePath.join(cwd, name)).catch(missingSetupPath);
    if (!entry) continue;
    if (!entry.isDirectory()) return null;
    modules.push(name);
  }
  if (!modules.includes("node_modules")) return null;
  const signal = AbortSignal.timeout(600_000);
  await checkWindowsWorktreeFiles(cwd, { modules, targets: modules, signal });
  return sealSetupTrees(cwd, modules, signal);
};

const canRunPreparePrivately = async (cwd: string, manifests: readonly string[]) => {
  for (const manifest of manifests) {
    const data = (await readJson(NodePath.join(cwd, manifest))) as {
      scripts?: Record<string, unknown>;
    };
    if (
      lifecycle.some(
        (name) =>
          data.scripts?.[name] !== undefined &&
          !(
            manifest === "package.json" &&
            name === "prepare" &&
            data.scripts[name] === prepareCommand
          ),
      )
    )
      return false;
  }
  return true;
};

const relocatePnpmState = async (staged: string, worktree: string) => {
  const modules = NodePath.join(staged, "node_modules");
  const canonicalStage = windowsSetupHost ? await NodeFSP.realpath(staged) : staged;
  const movePath = async (value: string) => {
    if (windowsSetupHost) {
      const relative = await windowsStagedPath(canonicalStage, value);
      return relative === undefined ? undefined : NodePath.join(worktree, relative);
    }
    return value === staged || value.startsWith(staged + NodePath.sep)
      ? worktree + value.slice(staged.length)
      : value;
  };
  const windowsPathSpelling = (value: string) =>
    value.replaceAll("\\\\", "\\").replaceAll("\\", "/").toLowerCase();
  const stageSpellings = [staged, canonicalStage].map(windowsPathSpelling);
  const includesStage = (value: string) => {
    if (!windowsSetupHost) return value.includes(staged);
    const normalized = windowsPathSpelling(value);
    return stageSpellings.some((spelling) => normalized.includes(spelling));
  };
  const modulesPath = NodePath.join(modules, ".modules.yaml");
  if (windowsSetupHost && !(await NodeFSP.lstat(modulesPath)).isFile()) return false;
  const rawLayout = await NodeFSP.readFile(modulesPath, "utf8");
  const layout = JSON.parse(rawLayout) as { virtualStoreDir?: string; nodeLinker?: string };
  if (
    (layout.virtualStoreDir !== undefined && layout.virtualStoreDir !== ".pnpm") ||
    (layout.nodeLinker !== undefined && layout.nodeLinker !== "isolated") ||
    includesStage(rawLayout)
  )
    return false;

  const lockPath = NodePath.join(modules, ".pnpm", "lock.yaml");
  const lock = await NodeFSP.lstat(lockPath).catch(missingSetupPath);
  if (
    lock &&
    (!lock.isFile() ||
      lock.size > 8 * 1024 * 1024 ||
      includesStage(await NodeFSP.readFile(lockPath, "utf8")))
  )
    return false;

  const statePath = NodePath.join(modules, ".pnpm-workspace-state-v1.json");
  if (await hasSetupEntry(statePath)) {
    const stat = await NodeFSP.lstat(statePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const state = (await readJson(statePath)) as {
      projects: Record<string, unknown>;
      pnpmfiles: string[];
    };
    if (!state.projects || !Array.isArray(state.pnpmfiles)) return false;
    const projects = new Map<string, unknown>();
    for (const [name, entry] of Object.entries(state.projects)) {
      const destination = await movePath(name);
      if (destination === undefined || projects.has(destination)) return false;
      projects.set(destination, entry);
    }
    const pnpmfiles = await Promise.all(state.pnpmfiles.map(movePath));
    if (pnpmfiles.includes(undefined)) return false;
    const relocated = JSON.stringify({
      ...state,
      projects: Object.fromEntries(projects),
      pnpmfiles,
    });
    if (includesStage(relocated)) return false;
    await NodeFSP.writeFile(statePath, relocated);
  }
  return true;
};

const relocateWindowsDependencyLinks = async (
  staged: string,
  worktree: string,
  modules: readonly string[],
) => {
  const canonicalStage = await NodeFSP.realpath(staged);
  // Resolve every target before replacing any link. pnpm can point one junction at another.
  const links: Array<{ file: string; target: string; kind: "junction" | "file" }> = [];
  const pending = modules.map((name) => NodePath.join(staged, name));
  while (pending.length) {
    const file = pending.pop()!;
    const stat = await NodeFSP.lstat(file);
    if (stat.isDirectory()) {
      for (const child of await NodeFSP.readdir(file)) pending.push(NodePath.join(file, child));
    } else if (stat.isSymbolicLink()) {
      const target = windowsLocalPath(await NodeFSP.readlink(file));
      const relative = await windowsStagedPath(
        canonicalStage,
        NodePath.resolve(NodePath.dirname(file), target),
      );
      const resolved = await NodeFSP.realpath(file).catch(missingSetupPath);
      if (
        relative === undefined ||
        !resolved ||
        relativeInside(canonicalStage, resolved) === undefined
      )
        return false;
      if (NodePath.isAbsolute(target)) {
        links.push({
          file,
          target: NodePath.join(worktree, relative),
          kind: (await NodeFSP.stat(file)).isDirectory() ? "junction" : "file",
        });
      }
    }
  }
  for (const { file, target, kind } of links) {
    await NodeFSP.unlink(file);
    await NodeFSP.symlink(target, file, kind);
  }
  return true;
};

export const installWorktreeDependencies = async (
  worktree: string,
  head: string,
  staging: string,
  owner: string,
  install: (cwd: string) => Promise<void>,
) => {
  if (
    !cleanSetupInputs(setupStatus(worktree)) ||
    !(await onlyAttemptMarkers(staging, owner, false))
  )
    return null;
  const manifests = git(worktree, "ls-files", "-v", "-z").split("\0").filter(Boolean);
  if (manifests.some((entry) => !entry.startsWith("H "))) return null;
  const packages = await workspaceManifests(
    worktree,
    manifests.map((entry) => entry.slice(2)),
  );
  if (!packages) return null;
  const expectedRoots = workspaceModuleRoots(packages);
  if (!(await canRunPreparePrivately(worktree, packages))) return null;

  // A dead setup leaves at most one private copy, inside its worktree. It may still have an installer.
  await NodeFSP.mkdir(staging, { mode: 0o700 });
  const inspectWindowsStage = () =>
    checkWindowsWorktreeFiles(staging, { privateStage: true }).then(
      () => true,
      (error) => {
        if (!(error instanceof WindowsWorktreeInspectionError)) throw error;
        process.stderr.write(`${error.message} for the dependency stage. Preserving the stage.\n`);
        return false;
      },
    );
  let stageInspected = windowsSetupHost ? undefined : true;
  try {
    const cwd = NodePath.join(staging, "repo");
    git(staging, "clone", "--quiet", "--shared", "--no-checkout", "--", worktree, cwd);
    git(cwd, "-c", "core.hooksPath=", "checkout", "--quiet", "--detach", head);
    await install(cwd);
    if (windowsSetupHost) {
      stageInspected = await inspectWindowsStage();
      if (!stageInspected) return null;
    }
    const modules: string[] = [];
    for (const name of expectedRoots) {
      const entry = await NodeFSP.lstat(NodePath.join(cwd, name)).catch(missingSetupPath);
      if (!entry) continue;
      if (windowsSetupHost && !entry.isDirectory()) return null;
      modules.push(name);
    }
    if (!modules.includes("node_modules"))
      throw new Error("Setup did not install root dependencies");
    const expected = new Set(modules.map((name) => "!! " + name + "/"));
    if (
      setupStatus(cwd)
        .split("\0")
        .some((record) => record !== "" && !expected.has(record))
    )
      return null;
    if (!(await relocatePnpmState(cwd, worktree))) return null;
    if (windowsSetupHost && !(await relocateWindowsDependencyLinks(cwd, worktree, modules)))
      return null;
    // pnpm hardlinks local file dependencies to their sources. Retire the private source checkout
    // before sealing so unlinking those aliases cannot change the published files' ctimes.
    const payload = NodePath.join(staging, "payload");
    for (const name of modules) {
      const source = NodePath.join(cwd, name);
      const target = NodePath.join(payload, name);
      if (
        (await NodeFSP.realpath(NodePath.dirname(source))) !== NodePath.dirname(source) ||
        !(await NodeFSP.lstat(source)).isDirectory()
      )
        return null;
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      await NodeFSP.rename(source, target);
    }
    await NodeFSP.rm(cwd, { recursive: true });
    const digests = await sealSetupTrees(
      payload,
      modules,
      AbortSignal.timeout(600_000),
      staging,
    ).catch((error) => {
      process.stderr.write(
        `Dependencies could not be sealed (${error instanceof Error ? error.message : String(error)}).\n`,
      );
      return null;
    });
    if (!digests) return null;

    if (
      git(worktree, "rev-parse", "--verify", "HEAD") !== head ||
      !cleanSetupInputs(setupStatus(worktree)) ||
      !(await onlyAttemptMarkers(staging, owner, true))
    )
      throw new Error("Worktree inputs or setup destinations changed during setup");
    for (const name of modules) {
      if (!(await stillAbsent(worktree, name)))
        throw new Error(`Setup destination already exists: ${name}`);
      await NodeFSP.rename(NodePath.join(payload, name), NodePath.join(worktree, name));
    }
    return digests;
  } finally {
    if (stageInspected ?? (await inspectWindowsStage()))
      await NodeFSP.rm(staging, { recursive: true, force: true });
  }
};

export const configureWorktreePrepare = async (worktree: string) => {
  if (await hasSetupEntry(NodePath.join(worktree, ".github/scripts/release-notes.cjs"))) {
    NodeChildProcess.execFileSync(
      process.execPath,
      [".github/scripts/release-notes.cjs", "configure"],
      {
        cwd: worktree,
        stdio: "inherit",
      },
    );
  }
};
