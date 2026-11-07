import type { AgentTerminalAccess, ServerSettings, WorktreeSubmodules } from "@t3tools/contracts";

import { msg, t, tn, type Message } from "~/i18n";
import { resolveEnvModeLabel, WORKTREE_SUBMODULES_LABELS } from "../BranchToolbar.logic";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";

const WRITING_STYLE_LABELS: Record<string, Message> = {
  repo_conventions: msg("Repository conventions"),
  conventional_commits: msg("Conventional Commits"),
  custom: msg("Custom instructions"),
};

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<string, Message> = {
  balanced: msg("Balanced"),
  performance: msg("Performance"),
  "battery-saver": msg("Battery saver"),
  custom: msg("Advanced"),
};

export const AGENT_TERMINAL_ACCESS_LABELS: Record<AgentTerminalAccess, Message> = {
  none: msg("No access"),
  read: msg("Read output"),
  "read-write": msg("Read and run commands"),
};

function labelOrRaw(label: Message | undefined, raw: string): string {
  return label === undefined ? raw : t(label);
}

export function formatSettingValue(key: keyof ServerSettings, value: unknown): string {
  if (value === null || value === undefined) {
    return key === "pullRequestMergeMethod"
      ? t("Last selected")
      : key === "sidebarAutoSettleAfterDays"
        ? t("Never")
        : key === "defaultModelSelection"
          ? t("Automatic")
          : key === "sourceControlWriterModelSelection"
            ? t("Text generation model")
            : key === "reviewGuideModelSelection"
              ? t("Source control writer model")
              : key === "defaultThreadEnvMode" || key === "worktreeSubmodules"
                ? t("Inherit")
                : t("Not set");
  }
  if (typeof value === "boolean") return value ? t("On") : t("Off");
  if (typeof value === "number") {
    return key === "sidebarAutoSettleAfterDays"
      ? tn(value, "{count} day", "{count} days")
      : String(value);
  }
  if (typeof value === "string") {
    if (key === "defaultThreadEnvMode" && (value === "local" || value === "worktree")) {
      return resolveEnvModeLabel(value);
    }
    if (key === "agentTerminalAccess" && value in AGENT_TERMINAL_ACCESS_LABELS) {
      return t(AGENT_TERMINAL_ACCESS_LABELS[value as AgentTerminalAccess]);
    }
    if (key === "worktreeSubmodules" && value in WORKTREE_SUBMODULES_LABELS) {
      return t(WORKTREE_SUBMODULES_LABELS[value as WorktreeSubmodules]);
    }
    if (key === "pullRequestMergeMethod" && value in PULL_REQUEST_MERGE_METHOD_LABELS) {
      return t(
        PULL_REQUEST_MERGE_METHOD_LABELS[value as keyof typeof PULL_REQUEST_MERGE_METHOD_LABELS],
      );
    }
    return value === "" ? t("Empty") : value;
  }
  if (Array.isArray(value)) return tn(value.length, "{count} item", "{count} items");
  if (typeof value === "object") {
    if (key === "backgroundActivity" && "profile" in value && typeof value.profile === "string") {
      const label = BACKGROUND_ACTIVITY_PROFILE_LABELS[value.profile];
      return label === undefined ? value.profile : t(label);
    }
    if ("model" in value && typeof value.model === "string") return value.model;
    if ("mode" in value && typeof value.mode === "string") {
      if (key === "worktreeCleanup") return value.mode === "off" ? "Off" : t("Custom");
      return key === "sourceControlWritingStyle"
        ? labelOrRaw(WRITING_STYLE_LABELS[value.mode], value.mode)
        : value.mode;
    }
  }
  return t("Custom");
}
