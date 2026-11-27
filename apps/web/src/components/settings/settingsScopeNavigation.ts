import { redirect, type SearchMiddleware } from "@tanstack/react-router";

import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
import { consolidatedSettingsAnchor, movedSettingsPath } from "./settingsSearch";

export function validateSettingsRouteSearch(raw: Record<string, unknown>) {
  return validateSettingsScopeSearch(
    typeof raw.environmentId === "string" && raw.machine === undefined && raw.project === undefined
      ? { ...raw, machine: raw.environmentId }
      : raw,
  );
}

const SCOPE_KEYS = [
  "project",
  "machine",
  "checkout",
] as const satisfies readonly (keyof SettingsScopeSearch)[];
const TARGET_INPUT_KEYS = [...SCOPE_KEYS, "environmentId"];

export const retainSettingsScope: SearchMiddleware<SettingsScopeSearch> = ({ search, next }) => {
  const result = next(search);
  if (TARGET_INPUT_KEYS.some((key) => Object.hasOwn(result, key))) return result;
  const previousScope = Object.fromEntries(
    SCOPE_KEYS.filter((key) => search[key] !== undefined).map((key) => [key, search[key]]),
  );
  return { ...previousScope, ...result };
};

/** Moved settings pages have no route file; the settings layout redirects them before a child matches. */
export function redirectMovedSettingsLocation(location: {
  readonly pathname: string;
  readonly hash: string;
}) {
  if (location.pathname === "/settings") {
    throw redirect({ to: "/settings/general", replace: true });
  }
  const moved = movedSettingsPath(location.pathname, location.hash);
  const hash = consolidatedSettingsAnchor(location.hash);
  if (moved || hash !== location.hash)
    throw redirect({ to: moved ?? location.pathname, search: true, hash, replace: true });
}
