import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import { onTestFinished, vi } from "vite-plus/test";
import { triageCommand } from "./triage.ts";

it.effect("checks and launches the requested triage agent from the session directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped();
    const tools = path.join(baseDir, "userdata", "fixture-tools");
    const executable = path.join(tools, isWindowsHost ? "codex.cmd" : "codex");
    yield* fs.makeDirectory(tools, { recursive: true });
    yield* fs.writeFileString(
      executable,
      isWindowsHost ? "@echo off\r\ncd > observed-cwd\r\n" : "#!/bin/sh\npwd > observed-cwd\n",
    );
    if (!isWindowsHost) yield* fs.chmod(executable, 0o755);
    vi.stubEnv("PATH", path.join("..", "..", "fixture-tools"));
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    yield* Command.runWith(triageCommand, { version: "0.0.0" })([
      "--base-dir",
      baseDir,
      "--agent",
      "codex",
    ]);
    const triageDir = path.join(baseDir, "userdata", "triage");
    const sessions = yield* fs.readDirectory(triageDir);
    expect(sessions).toHaveLength(1);
    const session = path.join(triageDir, sessions[0]!);
    const observed = yield* fs.readFileString(path.join(session, "observed-cwd"));
    expect(yield* fs.realPath(observed.trim())).toBe(yield* fs.realPath(session));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
