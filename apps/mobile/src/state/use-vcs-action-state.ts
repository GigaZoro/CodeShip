import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  type ResolvedVcsActionTarget,
  summarizeGitActionResult,
  summarizePullResult,
  type VcsActionState,
  type VcsActionTarget,
} from "@t3tools/client-runtime/state/vcs";
import type { GitRunStackedActionResult, VcsPullResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import { vcsActionManager } from "./vcs";
import { t } from "../lib/i18n";

export function useVcsActionState(target: VcsActionTarget): VcsActionState {
  return useAtomValue(vcsActionManager.stateAtom(target));
}

export interface GitActionResultNotification {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
  readonly prUrl?: string;
}

function successNotification(
  summary: { readonly title: string; readonly description: string | null },
  prUrl?: string,
): GitActionResultNotification {
  return {
    type: "success",
    title: summary.title,
    ...(summary.description === null ? {} : { description: summary.description }),
    ...(prUrl === undefined ? {} : { prUrl }),
  };
}

export function stackedActionSuccess(
  result: GitRunStackedActionResult,
  terminology: ChangeRequestTerminology,
): GitActionResultNotification {
  return successNotification(
    summarizeGitActionResult(result, terminology),
    result.pr.status === "skipped_not_requested" ? undefined : result.pr.url,
  );
}

export function pullSuccess(result: VcsPullResult): GitActionResultNotification {
  return successNotification(summarizePullResult(result));
}

const RESULT_DISMISS_MS = 5_000;

// A result belongs to the checkout it ran in, so another thread's screen never shows it.
const gitActionResultAtom = Atom.family((key: string) =>
  Atom.make<GitActionResultNotification | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:git-action-result:${key}`),
  ),
);
const NO_TARGET_RESULT_ATOM = Atom.make<GitActionResultNotification | null>(null).pipe(
  Atom.withLabel("mobile:git-action-result:none"),
);
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resultKey(target: VcsActionTarget): string | null {
  return target.environmentId === null || target.cwd === null
    ? null
    : JSON.stringify([target.environmentId, target.cwd]);
}

export function gitActionResultAtomFor(target: VcsActionTarget) {
  const key = resultKey(target);
  return key === null ? NO_TARGET_RESULT_ATOM : gitActionResultAtom(key);
}

function clearDismissTimer(key: string): void {
  const timer = dismissTimers.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  dismissTimers.delete(key);
}

export function showGitActionResult(
  target: ResolvedVcsActionTarget,
  result: GitActionResultNotification,
): void {
  // Best effort: devices without a haptics engine reject.
  Haptics.notificationAsync(
    result.type === "success"
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Error,
  ).catch(() => undefined);
  const key = JSON.stringify([target.environmentId, target.cwd]);
  clearDismissTimer(key);
  appAtomRegistry.set(gitActionResultAtom(key), result);
  // A failure stays until dismissed so its output can be read.
  if (result.type === "success") {
    dismissTimers.set(
      key,
      setTimeout(() => dismissGitActionResult(target), RESULT_DISMISS_MS),
    );
  }
}

export function dismissGitActionResult(target: VcsActionTarget): void {
  const key = resultKey(target);
  if (key === null) return;
  clearDismissTimer(key);
  appAtomRegistry.set(gitActionResultAtom(key), null);
}

export type GitActionProgressPhase = "idle" | "running" | "success" | "error";

export interface GitActionProgress {
  readonly phase: GitActionProgressPhase;
  readonly label: string | null;
  readonly description: string | null;
  readonly prUrl?: string;
}

const subscribeNever = () => () => {};

const EMPTY_PROGRESS: GitActionProgress = {
  phase: "idle",
  label: null,
  description: null,
};

function formatElapsedSeconds(ms: number | null, nowMs: number): string | null {
  if (ms === null) return null;
  const elapsed = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (elapsed < 2) return null;
  return t("Running for {seconds}s", { seconds: elapsed });
}

export function useGitActionProgress(target: VcsActionTarget): GitActionProgress {
  const actionState = useVcsActionState(target);
  const result = useAtomValue(gitActionResultAtomFor(target));

  // Only a running action shows elapsed time, so only it subscribes to the second tick.
  const nowMs = useSyncExternalStore(
    actionState.isRunning ? secondTick.subscribe : subscribeNever,
    secondTick.getSnapshot,
  );

  if (actionState.isRunning) {
    const description =
      actionState.lastOutputLine ??
      formatElapsedSeconds(actionState.hookStartedAtMs ?? actionState.phaseStartedAtMs, nowMs);
    return {
      phase: "running",
      label: actionState.currentLabel,
      description,
    };
  }

  if (result) {
    return {
      phase: result.type,
      label: result.title,
      description: result.description ?? null,
      prUrl: result.prUrl,
    };
  }

  return EMPTY_PROGRESS;
}
