import { useAtomValue } from "@effect/atom-react";
import { secondTick } from "@t3tools/client-runtime/clock";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  type ResolvedVcsActionTarget,
  summarizeGitActionResult,
  summarizePullResult,
  vcsActionLabelText,
  type VcsActionState,
  type VcsActionTarget,
} from "@t3tools/client-runtime/state/vcs";
import type { GitRunStackedActionResult, ScopedThreadRef, VcsPullResult } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useSyncExternalStore } from "react";

import { appAtomRegistry } from "./atom-registry";
import { vcsActionManager } from "./vcs";
import { t } from "../lib/i18n";

export function useVcsActionState(target: VcsActionTarget): VcsActionState {
  return useAtomValue(vcsActionManager.stateAtom(target));
}

interface RepositoryGitAction {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
}

// The tracked repository a thread last ran an action in, so the thread can show its progress.
const repositoryGitActionAtom = Atom.make<RepositoryGitAction | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:repository-git-action"),
);

export function noteRepositoryGitAction(action: RepositoryGitAction): void {
  appAtomRegistry.set(repositoryGitActionAtom, action);
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

// A result has a workspace-scoped owner. Draft actions only know their checkout.
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

type GitActionResultOwner = VcsActionTarget | ScopedThreadRef;

function resultKey(target: GitActionResultOwner): string | null {
  if ("threadId" in target)
    return JSON.stringify(["thread", target.environmentId, target.threadId]);
  return target.environmentId === null || target.cwd === null
    ? null
    : JSON.stringify(["checkout", target.environmentId, target.cwd]);
}

export function gitActionResultAtomFor(target: GitActionResultOwner) {
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
): void;
export function showGitActionResult(
  result: GitActionResultNotification & { readonly threadRef: ScopedThreadRef },
): void;
export function showGitActionResult(
  targetOrResult:
    | ResolvedVcsActionTarget
    | (GitActionResultNotification & { readonly threadRef: ScopedThreadRef }),
  checkoutResult?: GitActionResultNotification,
): void {
  const owner = "threadRef" in targetOrResult ? targetOrResult.threadRef : targetOrResult;
  const result = "threadRef" in targetOrResult ? targetOrResult : checkoutResult;
  const key = resultKey(owner);
  if (result === undefined || key === null) return;
  // Best effort: devices without a haptics engine reject.
  void Haptics.notificationAsync(
    result.type === "success"
      ? Haptics.NotificationFeedbackType.Success
      : Haptics.NotificationFeedbackType.Error,
  ).catch(() => undefined);
  clearDismissTimer(key);
  appAtomRegistry.set(gitActionResultAtom(key), result);
  // A failure stays until dismissed so its output can be read.
  if (result.type === "success") {
    dismissTimers.set(
      key,
      setTimeout(() => dismissGitActionResult(owner), RESULT_DISMISS_MS),
    );
  }
}

export function dismissGitActionResult(owner: GitActionResultOwner | null): void {
  if (owner === null) return;
  const key = resultKey(owner);
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

/** Checkout progress and the selected thread's own Git result. */
export function useGitActionProgress(
  target: VcsActionTarget,
  threadRef: ScopedThreadRef | null = null,
): GitActionProgress {
  const threadFolderState = useVcsActionState(target);
  const repositoryCwd = useAtomValue(repositoryGitActionAtom, (action) =>
    action !== null &&
    threadRef !== null &&
    action.threadRef.environmentId === threadRef.environmentId &&
    action.threadRef.threadId === threadRef.threadId
      ? action.cwd
      : null,
  );
  const repositoryState = useVcsActionState({
    environmentId: threadRef?.environmentId ?? null,
    cwd: repositoryCwd,
  });
  const actionState = repositoryState.isRunning ? repositoryState : threadFolderState;
  const threadResult = useAtomValue(
    threadRef === null ? NO_TARGET_RESULT_ATOM : gitActionResultAtomFor(threadRef),
  );
  const checkoutResult = useAtomValue(gitActionResultAtomFor(target));
  const result = threadResult ?? checkoutResult;

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
      label: vcsActionLabelText(actionState),
      description,
    };
  }

  if (result) {
    return {
      phase: result.type,
      label: result.title,
      description: result.description ?? null,
      ...(result.prUrl === undefined ? {} : { prUrl: result.prUrl }),
    };
  }

  return EMPTY_PROGRESS;
}
