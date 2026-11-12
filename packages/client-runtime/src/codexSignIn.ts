import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

/** CodeShip's ChatGPT sign-in (`managed`), or the login Codex keeps for itself (`existing`). */
export type CodexSignInMode = "managed" | "existing";

const BUILT_IN_CODEX = defaultInstanceIdForDriver(ProviderDriverKind.make("codex"));

const configFields = (config: unknown): { readonly [key: string]: unknown } =>
  typeof config === "object" && config !== null ? { ...config } : {};

const isSet = (value: unknown) => typeof value === "string" && value.trim() !== "";

export function readCodexSignInMode(config: unknown): CodexSignInMode {
  return configFields(config).setupMode === "managed" ? "managed" : "existing";
}

/**
 * Whether Codex's own login would be this machine's shared one, so a private login can set it
 * apart. Added accounts and accounts with their own home folder never share it.
 */
export function codexPrivateLoginApplies(instanceId: ProviderInstanceId, config: unknown): boolean {
  const fields = configFields(config);
  return instanceId === BUILT_IN_CODEX && !isSet(fields.homePath) && !isSet(fields.shadowHomePath);
}

export const readCodexPrivateLogin = (config: unknown) =>
  configFields(config).privateLogin === true;

export const withCodexSignInMode = (config: unknown, setupMode: CodexSignInMode) => ({
  ...configFields(config),
  enabled: true,
  setupMode,
});

export function withCodexPrivateLogin(config: unknown, privateLogin: boolean) {
  const rest = Object.fromEntries(
    Object.entries(configFields(config)).filter(([key]) => key !== "privateLogin"),
  );
  return privateLogin ? { ...rest, privateLogin: true } : rest;
}
