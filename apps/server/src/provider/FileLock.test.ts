// @effect-diagnostics nodeBuiltinImport:off - The lock is a file in a real temp directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { acquireFileLock } from "./FileLock.ts";

it.effect("a released lock can be taken again", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "file-lock-"));
    const target = NodePath.join(directory, "target");
    NodeFS.writeFileSync(target, "");
    const take = Effect.scoped(
      acquireFileLock(target, {
        realpath: false,
        retries: 0,
        onCompromised: () => Effect.void,
      }),
    );
    yield* take;
    yield* take;
    assert.isFalse(NodeFS.existsSync(`${target}.lock`));
  }),
);
