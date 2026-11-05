import type { BrowserImportFailureReason } from "@t3tools/contracts";

import { msg, t, type Message } from "./i18n.ts";

const FAILURE_MESSAGES: Readonly<Record<BrowserImportFailureReason, Message>> = {
  notInstalled: msg("Not installed on this machine."),
  needsKeychainApproval: msg("Needs Keychain access to read its cookies."),
  keychainItemMissing: msg(
    "No encryption key in your Keychain. Sign in to that browser once, then retry.",
  ),
  needsFullDiskAccess: msg(
    "Give T3.CodeShip Full Disk Access in System Settings → Privacy & Security, then retry.",
  ),
  browserRunning: msg("Quit the browser first so its cookie database can be read."),
  unsupportedPlatform: msg("Importing from this browser isn't possible on this platform."),
  keychainUnavailable: msg(
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  ),
  unknownSource: msg("That browser is no longer available to import from."),
  unknownSourceProfile: msg("That browser profile no longer exists."),
  sessionUnavailable: msg("The target profile could not be opened."),
  profileNotSaved: msg(
    "The cookies were imported, but the new profile couldn't be saved. Try again.",
  ),
  profileLimitReached: msg(
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  ),
  readFailed: msg("The browser's cookie database could not be read."),
};

export function browserImportFailureMessage(reason: BrowserImportFailureReason): string {
  return t(FAILURE_MESSAGES[reason]);
}
