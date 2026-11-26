// @effect-diagnostics nodeBuiltinImport:off - The inventory verifier uses native descriptor flags.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

import { CODEX_METADATA_INVENTORY } from "./cliRelease.ts";
import { verifyCodexMetadataInstallation } from "./codexMetadataInventory.ts";

const open = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ open }));

it("opens the required inventory without blocking and closes a nonregular handle without reading it", async () => {
  const handle = {
    stat: vi.fn().mockResolvedValue({ isFile: () => false }),
    readFile: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  open.mockResolvedValue(handle);

  await expect(verifyCodexMetadataInstallation("runtime", "required")).rejects.toThrow(
    "Expected a regular file",
  );

  expect(open).toHaveBeenCalledExactlyOnceWith(
    NodePath.join("runtime", CODEX_METADATA_INVENTORY),
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  expect(handle.stat).toHaveBeenCalledOnce();
  expect(handle.readFile).not.toHaveBeenCalled();
  expect(handle.close).toHaveBeenCalledOnce();
});
