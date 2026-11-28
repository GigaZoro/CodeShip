import { useSyncExternalStore } from "react";
import {
  type ClientSettings,
  type FoldFinishedWork,
  type InterfaceDensity,
  type StatusColors,
} from "@t3tools/contracts/settings";

import { msg, t, type Message } from "~/i18n";
import { getClientSettings, updateClientSettings } from "../../hooks/useSettings";
import {
  isDefaultThreadDetailsVisibility,
  matchingThreadDetailsPreset,
  RESET_THREAD_DETAILS_ITEMS,
  resolveThreadDetailsVisibility,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { toastManager } from "../ui/toast";

/**
 * One-switch "make it quiet" client settings bundle: compact spacing, Essentials thread details,
 * folding older finished turns, and calm status colors. Notifications are intentionally excluded
 * so alerts stay reachable without forcing the user to check more often.
 */
export const CALM_PRESET_SETTINGS = {
  interfaceDensity: "compact",
  threadDetailsItems: RESET_THREAD_DETAILS_ITEMS.threadDetailsItems,
  foldFinishedWork: "older",
  statusColors: "calm",
} as const satisfies Partial<ClientSettings>;

export type CalmPresetKey = keyof typeof CALM_PRESET_SETTINGS;
export type CalmPresetSettingsInput = Pick<ClientSettings, CalmPresetKey>;
export type CalmPresetPatch = Partial<Pick<ClientSettings, CalmPresetKey>>;

export interface CalmPresetChange {
  readonly key: CalmPresetKey;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

export interface CalmPresetPlan {
  readonly isActive: boolean;
  readonly changes: ReadonlyArray<CalmPresetChange>;
  readonly patch: CalmPresetPatch;
  readonly undoPatch: CalmPresetPatch;
}

export interface AppliedCalmPreset {
  readonly changes: ReadonlyArray<CalmPresetChange>;
  readonly undoPatch: CalmPresetPatch;
  readonly onUndone?: (() => void) | undefined;
}

const INTERFACE_DENSITY_LABELS: Record<InterfaceDensity, Message> = {
  comfortable: msg("Comfortable"),
  compact: msg("Compact spacing"),
};

const FOLD_FINISHED_WORK_LABELS: Record<FoldFinishedWork, Message> = {
  always: msg("Always"),
  older: msg("Older turns"),
  never: msg("Never"),
};

const STATUS_COLORS_LABELS: Record<StatusColors, Message> = {
  calm: msg("Calm"),
  vivid: msg("Vivid"),
};

export function selectCalmPresetSettings(settings: ClientSettings): CalmPresetSettingsInput {
  return {
    interfaceDensity: settings.interfaceDensity,
    threadDetailsItems: settings.threadDetailsItems,
    foldFinishedWork: settings.foldFinishedWork,
    statusColors: settings.statusColors,
  };
}

export function planCalmPreset(settings: CalmPresetSettingsInput): CalmPresetPlan {
  const changes: CalmPresetChange[] = [];
  const patch: {
    interfaceDensity?: InterfaceDensity;
    threadDetailsItems?: ClientSettings["threadDetailsItems"];
    foldFinishedWork?: FoldFinishedWork;
    statusColors?: StatusColors;
  } = {};
  const undoPatch: {
    interfaceDensity?: InterfaceDensity;
    threadDetailsItems?: ClientSettings["threadDetailsItems"];
    foldFinishedWork?: FoldFinishedWork;
    statusColors?: StatusColors;
  } = {};

  if (settings.interfaceDensity !== CALM_PRESET_SETTINGS.interfaceDensity) {
    changes.push({
      key: "interfaceDensity",
      label: t("Interface density"),
      from: t(INTERFACE_DENSITY_LABELS[settings.interfaceDensity]),
      to: t(INTERFACE_DENSITY_LABELS[CALM_PRESET_SETTINGS.interfaceDensity]),
    });
    patch.interfaceDensity = CALM_PRESET_SETTINGS.interfaceDensity;
    undoPatch.interfaceDensity = settings.interfaceDensity;
  }

  const visibility = resolveThreadDetailsVisibility(settings);
  if (!isDefaultThreadDetailsVisibility(visibility)) {
    const matchingPreset = matchingThreadDetailsPreset(visibility);
    const enabled = THREAD_DETAILS_ITEMS.filter((item) => visibility[item.id]).length;
    changes.push({
      key: "threadDetailsItems",
      label: t("Thread details"),
      from: matchingPreset
        ? t(matchingPreset.label)
        : t("{enabled} of {total} on", { enabled, total: THREAD_DETAILS_ITEMS.length }),
      to: t("Essentials"),
    });
    patch.threadDetailsItems = { ...CALM_PRESET_SETTINGS.threadDetailsItems };
    undoPatch.threadDetailsItems = { ...settings.threadDetailsItems };
  }

  if (settings.foldFinishedWork !== CALM_PRESET_SETTINGS.foldFinishedWork) {
    changes.push({
      key: "foldFinishedWork",
      label: t("Fold finished work"),
      from: t(FOLD_FINISHED_WORK_LABELS[settings.foldFinishedWork]),
      to: t(FOLD_FINISHED_WORK_LABELS[CALM_PRESET_SETTINGS.foldFinishedWork]),
    });
    patch.foldFinishedWork = CALM_PRESET_SETTINGS.foldFinishedWork;
    undoPatch.foldFinishedWork = settings.foldFinishedWork;
  }

  if (settings.statusColors !== CALM_PRESET_SETTINGS.statusColors) {
    changes.push({
      key: "statusColors",
      label: t("Status colors"),
      from: t(STATUS_COLORS_LABELS[settings.statusColors]),
      to: t(STATUS_COLORS_LABELS[CALM_PRESET_SETTINGS.statusColors]),
    });
    patch.statusColors = CALM_PRESET_SETTINGS.statusColors;
    undoPatch.statusColors = settings.statusColors;
  }

  return {
    isActive: changes.length === 0,
    changes,
    patch,
    undoPatch,
  };
}

export function formatCalmPresetChange(change: CalmPresetChange): string {
  return t("{label}: {from} → {to}", {
    label: change.label,
    from: change.from,
    to: change.to,
  });
}

export function formatCalmPresetChanges(changes: ReadonlyArray<CalmPresetChange>): string {
  return changes.map(formatCalmPresetChange).join(" · ");
}

const listeners = new Set<() => void>();
let lastApplied: AppliedCalmPreset | null = null;

function setLastApplied(next: AppliedCalmPreset | null): void {
  lastApplied = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribeLastApplied(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getLastAppliedSnapshot(): AppliedCalmPreset | null {
  return lastApplied;
}

export function useLastAppliedCalmPreset(): AppliedCalmPreset | null {
  return useSyncExternalStore(subscribeLastApplied, getLastAppliedSnapshot, () => null);
}

export function applyCalmPreset(options?: {
  readonly onUndone?: () => void;
}): AppliedCalmPreset | null {
  const plan = planCalmPreset(getClientSettings());
  if (plan.isActive) return null;
  const previous = lastApplied;
  void updateClientSettings(plan.patch);
  const record: AppliedCalmPreset = {
    changes: plan.changes,
    undoPatch: plan.undoPatch,
    onUndone: options?.onUndone,
  };
  previous?.onUndone?.();
  setLastApplied(record);
  return record;
}

export function undoCalmPreset(expected?: AppliedCalmPreset): boolean {
  const current = lastApplied;
  if (current === null) return false;
  if (expected !== undefined && current !== expected) return false;
  setLastApplied(null);
  current.onUndone?.();
  void updateClientSettings(current.undoPatch);
  return true;
}

export function applyCalmPresetWithToast(): AppliedCalmPreset | null {
  let toastId: string | null = null;
  const record = applyCalmPreset({
    onUndone: () => {
      if (toastId !== null) {
        const id = toastId;
        toastId = null;
        toastManager.close(id);
      }
    },
  });
  if (record === null) {
    toastManager.add({
      type: "info",
      title: t("Calm preset is already active"),
    });
    return null;
  }
  toastId = toastManager.add({
    type: "success",
    title: t("Calm preset applied"),
    description: formatCalmPresetChanges(record.changes),
    actionProps: {
      children: t("Undo"),
      onClick: () => {
        undoCalmPreset(record);
      },
    },
  });
  return record;
}

export function __resetCalmPresetForTests(): void {
  const previous = lastApplied;
  lastApplied = null;
  listeners.clear();
  previous?.onUndone?.();
}
