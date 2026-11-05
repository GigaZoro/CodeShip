import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { msg, t, type Message } from "@t3tools/shared/i18n";

const RUNTIME_NAMES: Partial<Record<string, Message>> = {
  claudeAgent: msg("Claude Code"),
  codex: msg("the Codex CLI"),
};

function formatModelList(names: ReadonlyArray<string>): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return t("{first} and {second}", { first: names[0]!, second: names[1]! });
  return t("{head}, and {last}", {
    head: names.slice(0, -1).join(", "),
    last: names[names.length - 1]!,
  });
}

export function formatProviderUpdateRequiredNotice(
  provider: Pick<ServerProvider, "driver" | "updateRequiredModels">,
  searchQuery = "",
): string | null {
  const query = searchQuery.trim().toLocaleLowerCase();
  const models = (provider.updateRequiredModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLocaleLowerCase().includes(query) ||
      model.slug.toLocaleLowerCase().includes(query),
  );
  if (models.length === 0) return null;
  const minVersion = models
    .map((model) => model.minVersion)
    .reduce((highest, version) =>
      compareSemverVersions(version, highest) > 0 ? version : highest,
    );
  const runtimeName = RUNTIME_NAMES[provider.driver];
  const providerName =
    runtimeName === undefined
      ? (PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver)
      : t(runtimeName);
  const version = minVersion.startsWith("v") ? minVersion : `v${minVersion}`;
  const names = formatModelList(models.map((model) => model.name));
  return t("Update {providerName} to {version} or newer to use {names}.", {
    providerName,
    version,
    names,
  });
}
