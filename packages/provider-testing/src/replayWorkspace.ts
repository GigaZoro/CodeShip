// @effect-diagnostics nodeBuiltinImport:off - Process exit cleanup removes the worker-local git template synchronously.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class ReplayFixtureGitCommandError extends Schema.TaggedError<ReplayFixtureGitCommandError>()(
  "ReplayFixtureGitCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit ${this.exitCode}.`;
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  ReplayFixtureGitCommandError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    if (Number(exitCode) !== 0) {
      return yield* new ReplayFixtureGitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: Number(exitCode),
      });
    }
  });
}

export type ReplayWorkspaceFiles = Readonly<Record<string, string>>;

let cachedTemplateDir: string | undefined;

const getOrCreateTemplateWorkspace = Effect.fn("getOrCreateTemplateWorkspace")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (cachedTemplateDir !== undefined && (yield* fs.exists(cachedTemplateDir))) {
    return cachedTemplateDir;
  }
  const templateDir = yield* fs.makeTempDirectory({
    prefix: "t3-orchestrator-v2-template-",
  });
  yield* runGit(templateDir, ["init"]);
  yield* runGit(templateDir, ["config", "user.name", "T3.CodeShip Test"]);
  yield* runGit(templateDir, ["config", "user.email", "t3code-test@example.com"]);
  yield* fs.writeFileString(path.join(templateDir, "README.md"), "# replay-workspace\n");
  yield* runGit(templateDir, ["add", "README.md"]);
  yield* runGit(templateDir, ["commit", "-m", "initial"]);
  cachedTemplateDir = templateDir;
  process.once("exit", () => {
    try {
      NodeFS.rmSync(templateDir, { recursive: true, force: true });
    } catch {
      // Ignore best-effort temp cleanup errors on exit.
    }
  });
  return templateDir;
});

const makeCheckpointWorkspaceEffect = Effect.fn("makeCheckpointWorkspace")(function* (
  fixtureName: string,
  files: ReplayWorkspaceFiles = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const templateDir = yield* getOrCreateTemplateWorkspace();
  const cwd = yield* fs.makeTempDirectory({
    prefix: `t3-orchestrator-v2-${fixtureName}-`,
  });
  yield* fs.copy(templateDir, cwd, { overwrite: true });
  const extraFiles = Object.keys(files);
  if (extraFiles.length > 0) {
    yield* fs.writeFileString(path.join(cwd, "README.md"), `# ${fixtureName}\n`);
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(cwd, relativePath);
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, contents);
    }
    yield* runGit(cwd, ["add", "README.md", ...extraFiles]);
    yield* runGit(cwd, ["commit", "--amend", "-m", "initial"]);
  }
  return cwd;
});

const removeCheckpointWorkspaceEffect = Effect.fn("removeCheckpointWorkspace")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(cwd, { recursive: true });
});

export const checkpointWorkspace = (fixtureName: string, files?: ReplayWorkspaceFiles) =>
  Effect.acquireRelease(makeCheckpointWorkspaceEffect(fixtureName, files), (cwd) =>
    removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

export const scratchWorkspace = (fixtureName: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectoryScoped({ prefix: `t3-orchestrator-v2-${fixtureName}-` }),
  ).pipe(Effect.provide(NodeServices.layer));

export async function makeCheckpointWorkspace(
  fixtureName: string,
  files?: ReplayWorkspaceFiles,
): Promise<string> {
  return await Effect.runPromise(
    makeCheckpointWorkspaceEffect(fixtureName, files).pipe(Effect.provide(NodeServices.layer)),
  );
}
