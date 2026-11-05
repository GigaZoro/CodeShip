import {
  isManagedCapabilityDenied,
  managedRuntimeModeCeilingFor,
  type ManagedCapability,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";

import { msg, t, type Message } from "./i18n.ts";

const CAPABILITY_LABELS: Record<ManagedCapability, Message> = {
  remoteClients: msg("connecting from other devices"),
  connect: msg("T3 Connect"),
  webhookTasks: msg("webhook tasks"),
  browserCookieImport: msg("importing browser cookies"),
};

const RUNTIME_MODE_LABELS: Record<RuntimeMode, Message> = {
  "approval-required": msg("Supervised"),
  "auto-accept-edits": msg("Auto-accept edits"),
  auto: msg("Auto"),
  "full-access": msg("Full access"),
};

/** The message every surface shows when the policy stops an update. */
export function managedUpdatesMessage(organization: string): string {
  return t("{organization} manages T3.CodeShip updates.", { organization });
}

/** The message when the policy allows only stable releases. */
export function managedNightlyDeniedMessage(organization: string): string {
  return t("{organization} manages T3.CodeShip updates. Only stable releases can be installed.", {
    organization,
  });
}

/** Why updates are unavailable on an environment with `summary`, or undefined when allowed. */
export function managedUpdatesDenial(summary: ManagedPolicySummary | undefined) {
  return summary?.limits?.updates?.mode === "off"
    ? managedUpdatesMessage(summary.organization)
    : undefined;
}

/** `capability` is a phrase the caller has already translated. */
export function managedPolicyDeniedMessage(organization: string, capability: string): string {
  return t("{organization}'s policy does not allow {capability}.", { organization, capability });
}

export function managedRuntimeModeCeilingMessage(organization: string, ceiling: RuntimeMode) {
  return t("{organization} limits threads to {mode}.", {
    organization,
    mode: t(RUNTIME_MODE_LABELS[ceiling]),
  });
}

export function managedRuntimeModeDenial(
  summary: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
): string | undefined {
  const ceiling = managedRuntimeModeCeilingFor(summary, mode);
  return summary !== undefined && ceiling !== undefined
    ? managedRuntimeModeCeilingMessage(summary.organization, ceiling)
    : undefined;
}

export function managedCapabilityDenial(
  summary: ManagedPolicySummary | undefined,
  capability: ManagedCapability,
): string | undefined {
  return summary !== undefined && isManagedCapabilityDenied(summary, capability)
    ? managedPolicyDeniedMessage(summary.organization, t(CAPABILITY_LABELS[capability]))
    : undefined;
}

/** Why a provider the administrator's policy leaves out cannot be used. */
export function disallowedProviderMessage(organization: string | undefined, label: string) {
  return organization === undefined
    ? t("Your organization's policy does not allow the {label} provider.", { label })
    : t("{organization}'s policy does not allow the {label} provider.", { organization, label });
}
