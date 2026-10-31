// @effect-diagnostics nodeBuiltinImport:off -- Clerk's bridge calls token storage from its own IPC handlers, outside any Effect runtime.
import type { TokenStorage } from "@clerk/electron";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

// Clerk's storage() marks unencrypted values this way, so either adapter reads the other's file.
const RAW_PREFIX = "raw:";

const decodeTokenFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Persists Clerk tokens unencrypted, in a file only the current user can read. */
export function make(stateDir: string): TokenStorage {
  const filePath = NodePath.join(stateDir, "clerk-tokens.json");

  const read = (): Record<string, unknown> => {
    let text: string;
    try {
      text = NodeFS.readFileSync(filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw cause;
    }
    return decodeTokenFile(text);
  };

  const write = (tokens: Record<string, unknown>) => {
    NodeFS.mkdirSync(stateDir, { recursive: true });
    // A new file gets the mode, and the rename replaces any older file with wider permissions.
    const temporaryPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      NodeFS.writeFileSync(temporaryPath, JSON.stringify(tokens), { mode: 0o600 });
      NodeFS.renameSync(temporaryPath, filePath);
    } catch (cause) {
      NodeFS.rmSync(temporaryPath, { force: true });
      throw cause;
    }
  };

  return {
    getItem: (key) => {
      const value = read()[key];
      return typeof value === "string" && value.startsWith(RAW_PREFIX)
        ? value.slice(RAW_PREFIX.length)
        : null;
    },
    setItem: (key, value) => write({ ...read(), [key]: RAW_PREFIX + value }),
    removeItem: (key) => {
      const { [key]: _removed, ...rest } = read();
      write(rest);
    },
  };
}
