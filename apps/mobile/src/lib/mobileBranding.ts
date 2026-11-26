import { msg, t } from "@t3tools/shared/i18n";

export type MobileStageLabel = "Beta" | "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Nightly";
  return "Beta";
}

const stageMessages = {
  Beta: msg("Beta"),
  Dev: msg("Dev"),
  Nightly: msg("Nightly"),
};

export function translateMobileStageLabel(appVariant: unknown): string {
  return t(stageMessages[resolveMobileStageLabel(appVariant)]);
}
