#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CODEX_METADATA_INVENTORY } from "@t3tools/shared/cliRelease";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  verifyInstall = false,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      // Isolate system Node and inherited launcher context from the archive smoke check.
      env: {
        PATH: "",
        HOME: cwd,
        USERPROFILE: cwd,
        TMPDIR: cwd,
        TEMP: cwd,
        ...(verifyInstall ? { T3CODE_VERIFY_INSTALL: "1" } : {}),
      },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

/**
 * One round trip through the detached command log writer, which only the packaged build runs: the bundle imports
 * node:process before `main`, and that makes stdin non-blocking. The input goes in after the writer starts reading.
 */
const smokeCommandLog = Effect.fn("smokeCommandLog")(function* (
  executable: string,
  cwd: string,
  scratch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const log = path.join(scratch, "command.log");
  const status = path.join(scratch, "command.status");
  const writer = yield* spawner.spawn(
    ChildProcess.make(executable, ["__command-log", log, status], {
      cwd,
      env: { PATH: "", HOME: cwd, TMPDIR: cwd },
      extendEnv: false,
    }),
  );
  const stderr = yield* Effect.forkScoped(collect(writer.stderr));
  const lines = yield* Stream.toPull(writer.stdout.pipe(Stream.decodeText(), Stream.splitLines));
  const [token] = yield* lines;
  yield* fs.writeFileString(`${status}.tmp`, "0\n");
  yield* Stream.run(Stream.make(new TextEncoder().encode(`output\n\0${token}\0`)), writer.stdin);
  const exitCode = yield* writer.exitCode.pipe(
    Effect.map(Number),
    Effect.timeout(Duration.seconds(10)),
  );
  const logged = yield* fs.readFileString(log);
  if (exitCode !== 0 || logged !== "output\n" || !(yield* fs.exists(status))) {
    return yield* new CliArchiveSmokeError({
      step: "capturing a command's output",
      detail: `exit ${String(exitCode)}, logged ${logged.length} bytes\n${yield* Fiber.join(stderr)}`,
    });
  }
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: string;
  readonly expectVersion: string;
  readonly expectCodexMetadata: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectory({ prefix: "t3-cli-smoke-" });
  // Windows can briefly retain executable locks; cleanup retries but must not fail a successful smoke check.
  yield* Effect.addFinalizer(() =>
    fs.remove(scratch, { recursive: true }).pipe(
      Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }),
      Effect.catch((error) =>
        Effect.logWarning(`[cli-smoke] could not remove ${scratch}: ${error.message}`),
      ),
    ),
  );

  // Windows bsdtar reads zip; Git Bash's GNU tar does not.
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const extract = yield* spawner
    .spawn(ChildProcess.make(tar, ["-xf", input.archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "t3.exe" : "t3");
  const bundledLibatomic = path.join(contentDir, "lib/libatomic.so.1");
  for (const required of [
    executable,
    path.join(contentDir, "client/index.html"),
    ...(input.expectCodexMetadata ? [path.join(contentDir, CODEX_METADATA_INVENTORY)] : []),
    ...(platform === "linux" ? [bundledLibatomic, `${bundledLibatomic}.LICENSE`] : []),
  ]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  // The runner has libatomic installed; fresh Ubuntu servers do not.
  if (platform === "linux") {
    const ldd = yield* spawner.string(ChildProcess.make("ldd", [executable]));
    // Older glibc prints the path as given, newer prints it resolved; compare both resolved.
    const loaded = /libatomic\.so\.1 => (\/.*) \(0x[0-9a-f]+\)/.exec(ldd)?.[1];
    if (
      loaded === undefined ||
      (yield* fs.realPath(loaded)) !== (yield* fs.realPath(bundledLibatomic))
    ) {
      return yield* new CliArchiveSmokeError({
        step: "checking that t3 loads the bundled libatomic",
        detail: ldd,
      });
    }
  }

  if (input.expectCodexMetadata) {
    const cli = path.join(
      contentDir,
      "codex-metadata",
      "bin",
      platform === "win32" ? "codex.exe" : "codex",
    );
    const help = yield* runExecutable(cli, ["exec", "--help"], scratch);
    if (help.exitCode !== 0 || !/^\s*--codeship-metadata-no-mcp(?:\s|$)/m.test(help.stdout)) {
      return yield* new CliArchiveSmokeError({
        step: "running the bundled Codex metadata program",
        detail: `exit ${String(help.exitCode)}\n${help.stderr}`,
      });
    }
  }

  if (input.expectCodexMetadata) {
    // A required SEA must still reject the install when both external indicators disappear.
    const packagePath = path.join(contentDir, "codex-metadata");
    const inventory = path.join(contentDir, CODEX_METADATA_INVENTORY);
    yield* fs.rename(packagePath, packagePath + ".test");
    yield* fs.rename(inventory, inventory + ".test");
    const damaged = yield* runExecutable(executable, ["--version"], contentDir, true);
    if (damaged.exitCode !== 78) {
      return yield* new CliArchiveSmokeError({
        step: "rejecting a missing required Codex package",
        detail: `unexpected exit ${damaged.exitCode}`,
      });
    }
    yield* fs.rename(inventory + ".test", inventory);
    yield* fs.rename(packagePath + ".test", packagePath);
  }

  const version = yield* runExecutable(executable, ["--version"], contentDir, true);
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  if (platform !== "win32") yield* smokeCommandLog(executable, contentDir, scratch);

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  const server = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
      {
        cwd: contentDir,
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          TMPDIR: scratch,
          TEMP: scratch,
          T3CODE_HOME: home,
          // The archive has a release channel built in, so its events would
          // look like a real new install.
          T3CODE_TELEMETRY_ENABLED: "false",
        },
        extendEnv: false,
      },
    ),
  );
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)]),
  );
  const httpClient = yield* HttpClient.HttpClient;
  // Probes can hang during server initialization; bound each request as SSH readiness does.
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const pollUntilReady = Effect.gen(function* () {
    while (!(yield* probe)) {
      yield* Effect.sleep(Duration.millis(250));
    }
    return true;
  });
  const ready = yield* pollUntilReady.pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => false),
  );
  yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
  yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  const [stdout, stderr] = yield* Fiber.join(output).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.orElseSucceed(() => ["", ""] as const),
  );
  if (!ready) {
    return yield* new CliArchiveSmokeError({
      step: "serving from the extracted archive",
      detail: `no 200 from / within 30s\n${stdout}${stderr}`,
    });
  }
  yield* Effect.log(
    `[cli-smoke] ${root}: --version passed, command output was captured and serve answered on ${String(port)}.`,
  );
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive"),
    expectVersion: Flag.String("expect-version"),
    expectCodexMetadata: Flag.Boolean("expect-codex-metadata"),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Extract a CLI archive and run its executable."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
