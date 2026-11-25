// Release builds hand child processes only named variables, never the step's credentials.
// Windows names are case-insensitive, so names compare uppercased.

// What any user's machine sets.
const SYSTEM_ENV_NAMES = [
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
];

// Packaged code runs inside the signing step.
const PACKAGED_PROBE_ENV_NAMES = new Set(SYSTEM_ENV_NAMES);

// Dependency install scripts run with these: the system, where pnpm caches, how the registry is
// reached, and the toolchain node-gyp compiles with. pnpm's registry auth settings stay out.
const STAGE_INSTALL_ENV_NAMES = new Set([
  ...SYSTEM_ENV_NAMES,
  "CI",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PNPM_HOME",
  "PNPM_CONFIG_CACHE_DIR",
  "PNPM_CONFIG_STORE_DIR",
  "PNPM_CONFIG_PREFER_OFFLINE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PYTHON",
  "NPM_CONFIG_PYTHON",
  "NPM_CONFIG_MSVS_VERSION",
  "GYP_MSVS_VERSION",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "DEVELOPER_DIR",
  "SDKROOT",
  "MACOSX_DEPLOYMENT_TARGET",
]);

const pickEnv = (
  source: Readonly<Record<string, string | undefined>>,
  names: ReadonlySet<string>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && names.has(name.toUpperCase())) env[name] = value;
  }
  return env;
};

export const packagedProbeEnv = (
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> => ({ ...pickEnv(source, PACKAGED_PROBE_ENV_NAMES), ...overrides });

export const stageInstallEnv = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => pickEnv(source, STAGE_INSTALL_ENV_NAMES);
