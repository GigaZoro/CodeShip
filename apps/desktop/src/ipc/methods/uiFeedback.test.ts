import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { allWindows } = vi.hoisted(() => ({ allWindows: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: allWindows } }));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { captureUiFeedbackWindow, writeUiFeedbackExport } from "./uiFeedback.ts";

interface FakeImage {
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  resize: ReturnType<typeof vi.fn>;
  toJPEG: () => Buffer;
}

const fakeImage = (width: number, height: number, empty = false): FakeImage => {
  const image: FakeImage = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: vi.fn(({ width: next }: { width: number; quality?: string }) =>
      fakeImage(next, Math.round((height * next) / width)),
    ),
    toJPEG: () => Buffer.from("jpeg"),
  };
  return image;
};

const fakeWindow = (id: number, image: FakeImage) => ({
  isDestroyed: () => false,
  webContents: { id, capturePage: vi.fn(async () => image) },
});

describe("captureUiFeedbackWindow", () => {
  const capture = (senderId: number) =>
    captureUiFeedbackWindow.handler(undefined, { sender: { id: senderId } });

  it.effect("captures only the window that sent the request", () =>
    Effect.gen(function* () {
      const mine = fakeWindow(1, fakeImage(800, 600));
      const other = fakeWindow(2, fakeImage(800, 600));
      allWindows.mockReturnValue([other, mine]);
      const result = yield* capture(1);
      assert.deepEqual(result, {
        dataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`,
        width: 800,
        height: 600,
      });
      assert.strictEqual(other.webContents.capturePage.mock.calls.length, 0);
      assert.isNull(yield* capture(3));
    }),
  );

  it.effect("returns null for an empty image and a failed capture", () =>
    Effect.gen(function* () {
      allWindows.mockReturnValue([fakeWindow(1, fakeImage(0, 0, true))]);
      assert.isNull(yield* capture(1));
      const failing = fakeWindow(1, fakeImage(10, 10));
      failing.webContents.capturePage.mockRejectedValue(new Error("no frame"));
      allWindows.mockReturnValue([failing]);
      assert.isNull(yield* capture(1));
    }),
  );

  it.effect("downsizes a wide capture to 1600 px keeping the aspect ratio", () =>
    Effect.gen(function* () {
      const wide = fakeImage(3200, 1800);
      allWindows.mockReturnValue([fakeWindow(1, wide)]);
      const result = (yield* capture(1)) as { width: number; height: number } | null;
      assert.deepEqual(wide.resize.mock.calls[0], [{ width: 1600, quality: "good" }]);
      assert.strictEqual(result?.width, 1600);
      assert.strictEqual(result?.height, 900);
    }),
  );
});

describe("writeUiFeedbackExport", () => {
  const withHome = <A, E>(
    use: (stateDir: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ directory: NodeOS.tmpdir() }),
        "userdata",
      );
      return yield* use(stateDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  const write = (stateDir: string, markdown: string) =>
    writeUiFeedbackExport.handler(markdown).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            stateDir,
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
        ),
      ),
    );

  it.effect("writes the export under the state directory and returns its path", () =>
    withHome((stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const expected = path.join(stateDir, "ui-feedback", "ui-feedback.md");
        assert.strictEqual(yield* write(stateDir, "# first"), expected);
        assert.strictEqual(yield* write(stateDir, "# second"), expected);
        assert.strictEqual(yield* fileSystem.readFileString(expected), "# second");
      }),
    ),
  );

  it.effect("rejects an export over 2 MiB without writing", () =>
    withHome((stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const exit = yield* Effect.exit(write(stateDir, "x".repeat(2 * 1024 * 1024 + 1)));
        assert.strictEqual(exit._tag, "Failure");
        assert.isFalse(yield* fileSystem.exists(stateDir));
      }),
    ),
  );
});
