import { t, tn } from "~/i18n";
import {
  EasDeviceHostConfig,
  type EasDeviceHostConfig as EasDeviceHostConfigType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const parseEasDeviceHostDraft = Schema.decodeUnknownOption(EasDeviceHostConfig);

export const newEasDeviceHost = (id: string): EasDeviceHostConfigType => ({
  kind: "eas",
  id,
  // oxlint-disable-next-line t3code/no-untranslated-text -- default host name stored in settings
  label: "EAS Simulator",
  accessToken: "",
  maxSessionMinutes: 30,
  idleMinutes: 10,
  maxConcurrentSessions: 2,
});

/** Adds, replaces, or removes one EAS host. */
/**
 * With `keepToken`, the environment keeps the token it holds: a saved token arrives redacted, and
 * one environment's token says nothing about another's. One new to the host uses its own Expo login.
 */
export function updateEasDeviceHosts(
  hosts: ReadonlyArray<EasDeviceHostConfigType>,
  host: EasDeviceHostConfigType,
  remove: boolean,
  keepToken = false,
): ReadonlyArray<EasDeviceHostConfigType> {
  if (remove) return hosts.filter((candidate) => candidate.id !== host.id);
  const existing = hosts.find((candidate) => candidate.id === host.id);
  const next = keepToken ? { ...host, accessToken: existing?.accessToken ?? "" } : host;
  return existing
    ? hosts.map((candidate) => (candidate.id === host.id ? next : candidate))
    : [...hosts, next];
}

export function easSessionLimits(host: EasDeviceHostConfigType) {
  return t(
    "Up to {sessions} at once, each stopped after {maxMinutes} min or {idleMinutes} idle min",
    {
      sessions: tn(host.maxConcurrentSessions, "{count} session", "{count} sessions"),
      maxMinutes: host.maxSessionMinutes,
      idleMinutes: host.idleMinutes,
    },
  );
}
