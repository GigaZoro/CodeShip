import {
  managedNightlyDeniedMessage,
  managedUpdatesMessage,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import type { CliReleaseChannel } from "@t3tools/shared/cliRelease";

/**
 * Why the managed policy refuses an update a user or maintainer asked for, or `undefined` when it
 * allows it. `auto` allows every update, whether a person asked for it or the server installs it
 * itself (`installUpdatesAutomatically`); `off` refuses both.
 * Pass `targetChannel` when the caller picks the release; the desktop app gates its own channel.
 */
export function managedUpdateRefusal(
  document: ManagedPolicyDocument | undefined,
  targetChannel?: CliReleaseChannel,
): string | undefined {
  const updates = document?.limits?.updates;
  if (document === undefined || updates === undefined) return undefined;
  if (updates.mode === "off") return managedUpdatesMessage(document.organization);
  if (updates.allowNightly === false && targetChannel !== undefined && targetChannel !== "stable") {
    return managedNightlyDeniedMessage(document.organization);
  }
  return undefined;
}
