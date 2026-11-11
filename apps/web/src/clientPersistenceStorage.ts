import {
  ClientSettingsSchema,
  StoredClientSettingsSchema,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  setLocalStorageItem,
  LocalStorageOperationError,
} from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
const decodeStoredClientSettings = Schema.decodeSync(StoredClientSettingsSchema);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  const document = getLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    Schema.Record(Schema.String, Schema.Unknown),
  );
  if (document === null) return null;
  let settings: ClientSettings;
  try {
    settings = decodeStoredClientSettings(document);
  } catch (cause) {
    throw new LocalStorageOperationError({
      operation: "decode",
      storageKey: CLIENT_SETTINGS_STORAGE_KEY,
      cause,
    });
  }
  if (
    Object.hasOwn(document, "sidebarGroupBy") ||
    Object.hasOwn(document, "legacySidebarEnabled")
  ) {
    try {
      writeBrowserClientSettings(settings);
    } catch (cause) {
      console.warn("Could not persist migrated browser client settings.", cause);
    }
  }
  return settings;
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
