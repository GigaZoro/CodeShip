import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import { downloadElectronRuntime } from "./ensure-electron-runtime.mjs";

const VERSION = "44.10.0";
const REAL_ARCHIVE_DIGEST = NodeCrypto.createHash("sha256")
  .update("the real archive")
  .digest("hex");

function makeElectronDir() {
  const electronDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-test-"));
  return {
    electronDir,
    [Symbol.dispose]: () => NodeFS.rmSync(electronDir, { recursive: true, force: true }),
  };
}

describe("downloadElectronRuntime", () => {
  it.each([
    {
      name: "a digest that differs from electron/checksums.json",
      checksums: (archiveName) => ({ [archiveName]: REAL_ARCHIVE_DIGEST }),
      error: `but electron/checksums.json expects ${REAL_ARCHIVE_DIGEST}`,
    },
    {
      name: "an archive electron/checksums.json does not list",
      checksums: () => ({}),
      error: `electron/checksums.json has no SHA-256 for electron-v${VERSION}-`,
    },
  ])("refuses to extract $name", ({ checksums, error }) => {
    using fixture = makeElectronDir();
    const download = (_url, zipPath) => {
      NodeFS.writeFileSync(
        NodePath.join(fixture.electronDir, "checksums.json"),
        JSON.stringify(checksums(NodePath.basename(zipPath))),
      );
      NodeFS.writeFileSync(zipPath, "not the archive electron published");
    };

    assert.throws(() => downloadElectronRuntime(fixture.electronDir, VERSION, download), error);
    assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.electronDir, "dist")));
  });
});
