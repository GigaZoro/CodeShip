// Packaged code runs inside the signing step, so it gets only what any user's machine sets, never
// that step's credentials. Windows names are case-insensitive, so names compare uppercased.
const PACKAGED_PROBE_ENV_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]);

export const packagedProbeEnv = (
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && PACKAGED_PROBE_ENV_NAMES.has(name.toUpperCase())) env[name] = value;
  }
  return { ...env, ...overrides };
};
