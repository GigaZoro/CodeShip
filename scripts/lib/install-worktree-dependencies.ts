// @effect-diagnostics nodeBuiltinImport:off -- Setup runs before dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { missingSetupPath, sealSetupTrees } from "./worktree-setup-proof.ts";

const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  }).trimEnd();

export const setupStatus = (cwd: string) =>
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

const onlyAttemptMarkers = async (staging: string, ownStage: boolean) => {
  const paths = await NodeFSP.readdir(NodePath.dirname(staging));
  return paths.every(
    (name) =>
      name === "setup-running" ||
      /^setup-owner-[1-9]\d*$/.test(name) ||
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
  const movePath = (value: string) =>
    value === staged || value.startsWith(staged + NodePath.sep)
      ? worktree + value.slice(staged.length)
      : value;
  const modulesPath = NodePath.join(modules, ".modules.yaml");
  const rawLayout = await NodeFSP.readFile(modulesPath, "utf8");
  const layout = JSON.parse(rawLayout) as { virtualStoreDir?: string; nodeLinker?: string };
  if (
    (layout.virtualStoreDir !== undefined && layout.virtualStoreDir !== ".pnpm") ||
    (layout.nodeLinker !== undefined && layout.nodeLinker !== "isolated") ||
    rawLayout.includes(staged)
  )
    return false;

  const lockPath = NodePath.join(modules, ".pnpm", "lock.yaml");
  const lock = await NodeFSP.lstat(lockPath).catch(missingSetupPath);
  if (
    lock &&
    (!lock.isFile() ||
      lock.size > 8 * 1024 * 1024 ||
      (await NodeFSP.readFile(lockPath, "utf8")).includes(staged))
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
    const relocated = JSON.stringify({
      ...state,
      projects: Object.fromEntries(
        Object.entries(state.projects).map(([name, entry]) => [movePath(name), entry]),
      ),
      pnpmfiles: state.pnpmfiles.map(movePath),
    });
    if (relocated.includes(staged)) return false;
    await NodeFSP.writeFile(statePath, relocated);
  }
  return true;
};

export const installWorktreeDependencies = async (
  worktree: string,
  head: string,
  staging: string,
  install: (cwd: string) => Promise<void>,
) => {
  if (!cleanSetupInputs(setupStatus(worktree)) || !(await onlyAttemptMarkers(staging, false)))
    return null;
  const manifests = git(worktree, "ls-files", "-v", "-z").split("\0").filter(Boolean);
  if (manifests.some((entry) => !entry.startsWith("H "))) return null;
  const packages = await workspaceManifests(
    worktree,
    manifests.map((entry) => entry.slice(2)),
  );
  if (!packages) return null;
  const expectedRoots = [
    ...new Set([
      "node_modules",
      ...packages
        .filter((name) => name !== "package.json")
        .map((name) => name.slice(0, -"package.json".length) + "node_modules"),
    ]),
  ];
  if (!(await canRunPreparePrivately(worktree, packages))) return null;

  // A dead setup leaves at most one private copy, inside its worktree. It may still have an installer.
  await NodeFSP.mkdir(staging, { mode: 0o700 });
  try {
    const cwd = NodePath.join(staging, "repo");
    git(staging, "clone", "--quiet", "--shared", "--no-checkout", "--", worktree, cwd);
    git(cwd, "-c", "core.hooksPath=", "checkout", "--quiet", "--detach", head);
    await install(cwd);
    const modules: string[] = [];
    for (const name of expectedRoots) {
      if (await hasSetupEntry(NodePath.join(cwd, name))) modules.push(name);
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
    ).catch(() => null);
    if (!digests) return null;

    if (
      git(worktree, "rev-parse", "--verify", "HEAD") !== head ||
      !cleanSetupInputs(setupStatus(worktree)) ||
      !(await onlyAttemptMarkers(staging, true))
    )
      throw new Error("Worktree inputs or setup destinations changed during setup");
    for (const name of modules) {
      if (!(await stillAbsent(worktree, name)))
        throw new Error(`Setup destination already exists: ${name}`);
      await NodeFSP.rename(NodePath.join(payload, name), NodePath.join(worktree, name));
    }
    return digests;
  } finally {
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
