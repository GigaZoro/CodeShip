// @effect-diagnostics nodeBuiltinImport:off -- reads the real scheduling priority of a child.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { raiseAboveChildren } from "./serverPriority.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("raiseAboveChildren", () => {
  it.effect("runs the server above the processes it starts", () =>
    Effect.gen(function* () {
      const original = NodeOS.getPriority();
      yield* Effect.addFinalizer(() => Effect.sync(() => NodeOS.setPriority(original)));
      yield* raiseAboveChildren();
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        ["-p", "require('node:os').getPriority()"],
        { encoding: "utf8" },
      );
      const server = NodeOS.getPriority();
      expect(server).toBe(NodeOS.constants.priority.PRIORITY_ABOVE_NORMAL);
      expect(Number(child.stdout.trim())).toBeGreaterThan(server);
    }).pipe(Effect.scoped),
  );
});
