// @effect-diagnostics nodeBuiltinImport:off - This also runs in the Vite build and the installer's early CLI probe.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { CODEX_METADATA_INVENTORY } from "./cliRelease.ts";

declare const __T3CODE_CODEX_METADATA_INVENTORY_SHA256__: string | undefined;

export const embeddedCodexMetadataDigest =
  typeof __T3CODE_CODEX_METADATA_INVENTORY_SHA256__ === "string"
    ? __T3CODE_CODEX_METADATA_INVENTORY_SHA256__
    : "";

export async function codexMetadataInventory(directory: string): Promise<string> {
  if (!(await NodeFSP.lstat(directory)).isDirectory()) {
    throw new Error(`Expected a native Codex package directory at ${directory}`);
  }
  const rows: string[] = [];
  for (const entry of await NodeFSP.readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const file = NodePath.join(entry.parentPath, entry.name);
    const member = NodePath.relative(directory, file).split(NodePath.sep).join("/");
    if (!entry.isFile() || /[\r\n]/.test(member)) {
      throw new Error(`Invalid native Codex package member: ${member}`);
    }
    const stat = await NodeFSP.stat(file);
    const posixExecutable = (stat.mode & 0o111) !== 0 && !member.endsWith(".exe");
    if (posixExecutable) await NodeFSP.access(file, NodeFS.constants.X_OK);
    const hash = NodeCrypto.createHash("sha256");
    for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
    const executable = member.endsWith(".exe") || posixExecutable;
    rows.push(`${executable ? "x" : "f"} ${hash.digest("hex")} ${member}`);
  }
  if (!rows.length) throw new Error(`Empty Codex package at ${directory}`);
  return rows.sort().join("\n") + "\n";
}

export function codexMetadataInventoryDigest(inventory: string): string {
  return NodeCrypto.hash("sha256", inventory);
}

export async function verifyCodexMetadataInstallation(
  resources: string,
  expectedDigest: string,
): Promise<void> {
  if (!expectedDigest) return;
  const installed = await NodeFSP.readFile(
    NodePath.join(resources, CODEX_METADATA_INVENTORY),
    "utf8",
  );
  if (
    codexMetadataInventoryDigest(installed) !== expectedDigest ||
    (await codexMetadataInventory(NodePath.join(resources, "codex-metadata"))) !== installed
  ) {
    throw new Error("The installed Codex metadata package differs from the release inventory.");
  }
}
