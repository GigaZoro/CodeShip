import { t, tn } from "~/i18n";
import { useAtomCommand } from "~/state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import { trackPendingDraftCheckout } from "~/lib/draftWorkspaceDefaults";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { toastManager } from "../ui/toast";
import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";
import {
  checkoutFailureDescription,
  appendHandoff,
  mergeHeadPin,
  readableFailure,
} from "./pullRequestDetail.logic";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

import { changeRequestTermKind, type ChangeRequestTermKind } from "./changeRequestTerm";

export function usePullRequestDefaultMergeMethodResolver(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  const projectDefault = useEnvironmentSettings(
    environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.pullRequestMergeMethod,
  );
  const legacyOverrides = useClientSettings((settings) => settings.pullRequestMergeMethodOverrides);
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return () => {
    if (projectDefault != null) return projectDefault;
    if (Object.keys(legacyOverrides).length === 0) return undefined;
    const project = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    if (!project) return undefined;
    const key =
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: grouping,
        primaryEnvironmentId,
      }).get(derivePhysicalProjectKey(project)) ??
      deriveLogicalProjectKeyFromSettings(project, grouping);
    return legacyOverrides[key];
  };
}

const actionSuccessLabels = (term: ChangeRequestTermKind): Record<PullRequestAction, string> => ({
  merge: t("Merge requested"),
  ready: t("Marked ready for review"),
  draft: t("Converted to draft"),
  close:
    term === "mr"
      ? t("Merge request closed")
      : term === "cr"
        ? t("Change request closed")
        : t("Pull request closed"),
  reopen:
    term === "mr"
      ? t("Merge request reopened")
      : term === "cr"
        ? t("Change request reopened")
        : t("Pull request reopened"),
  "update-branch": t("Branch updated with the base branch"),
  "enable-auto-merge": t("Auto-merge enabled"),
  "disable-auto-merge": t("Auto-merge disabled"),
  revert:
    term === "mr"
      ? t("Revert merge request opened")
      : term === "cr"
        ? t("Revert change request opened")
        : t("Revert pull request opened"),
  "delete-branch": t("Branch deleted"),
  "approve-workflows": t("Workflows approved"),
});

const actionFailureLabels = (term: ChangeRequestTermKind): Record<PullRequestAction, string> => ({
  merge:
    term === "mr"
      ? t("Could not merge this merge request")
      : term === "cr"
        ? t("Could not merge this change request")
        : t("Could not merge this pull request"),
  ready: t("Could not mark this ready for review"),
  draft: t("Could not convert this to a draft"),
  close:
    term === "mr"
      ? t("Could not close this merge request")
      : term === "cr"
        ? t("Could not close this change request")
        : t("Could not close this pull request"),
  reopen:
    term === "mr"
      ? t("Could not reopen this merge request")
      : term === "cr"
        ? t("Could not reopen this change request")
        : t("Could not reopen this pull request"),
  "update-branch": t("Could not update this branch"),
  "enable-auto-merge": t("Could not enable auto-merge"),
  "disable-auto-merge": t("Could not disable auto-merge"),
  revert:
    term === "mr"
      ? t("Could not open a revert merge request")
      : term === "cr"
        ? t("Could not open a revert change request")
        : t("Could not open a revert pull request"),
  "delete-branch": t("Could not delete this branch"),
  "approve-workflows": t("Could not approve workflows"),
});

const actionFailureHints = (term: ChangeRequestTermKind): Record<PullRequestAction, string> => ({
  merge: t(
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ),
  ready: t("The host refused it. Check that you have write access to this repository."),
  draft: t("The host refused it. Check that you have write access to this repository."),
  close: t("The host refused it. Check that you have write access, or that you opened it."),
  reopen: t(
    "The host refused it. Check that you have write access, and that the branch still exists.",
  ),
  "update-branch": t(
    "The host refused it. Check that you have write access, and that the base branch has not diverged in a way the host cannot merge.",
  ),
  "enable-auto-merge": t(
    "The host refused it. Check that auto-merge is enabled for this repository and that you have write access.",
  ),
  "disable-auto-merge": t(
    "The host refused it. Check that you have write access to this repository.",
  ),
  revert:
    term === "mr"
      ? t(
          "The host refused it. Check that you have write access and that this merge request was merged on the host.",
        )
      : term === "cr"
        ? t(
            "The host refused it. Check that you have write access and that this change request was merged on the host.",
          )
        : t(
            "The host refused it. Check that you have write access and that this pull request was merged on the host.",
          ),
  "delete-branch": t(
    "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  ),
  "approve-workflows": t(
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
  ),
});

export function usePullRequestActionRunner({
  environmentId,
  reference,
  headSha,
  terminology,
  onSuccess,
  onFailure,
  resolveMergeMethod,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef | null;
  /** The head on screen, which a merge is pinned to. */
  headSha?: string | undefined;
  onFailure?: (action: PullRequestAction) => void;
  terminology: ChangeRequestTerminology;
  onSuccess?: (action: PullRequestAction, reply: PullRequestSummary | undefined) => void;
  /** Resolve repository settings on click to avoid per-row reads. */
  resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
}) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, {
    reportFailure: false,
  });
  const pendingRef = useRef(new Map<string, PullRequestAction>());
  const [pendingActions, setPendingActions] = useState<ReadonlyMap<string, PullRequestAction>>(
    () => new Map(),
  );
  const actionKey =
    reference === null
      ? null
      : JSON.stringify([
          environmentId,
          reference.projectId,
          reference.host ?? null,
          reference.repository,
          reference.number,
        ]);
  const pendingAction = actionKey === null ? null : (pendingActions.get(actionKey) ?? null);
  const actionPending = pendingAction !== null;

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionKey === null || reference === null || pendingRef.current.has(actionKey)) return;
    pendingRef.current.set(actionKey, action);
    setPendingActions(new Map(pendingRef.current));
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        action,
        ...mergeHeadPin(action, headSha),
        ...(method ? { mergeMethod: method } : resolveMergeMethod ? { resolveMergeMethod } : {}),
      },
    });
    pendingRef.current.delete(actionKey);
    setPendingActions(new Map(pendingRef.current));
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: actionFailureLabels(changeRequestTermKind(terminology))[action],
        description: readableFailure(
          squashAtomCommandFailure(result),
          actionFailureHints(changeRequestTermKind(terminology))[action],
        ),
      });
      onFailure?.(action);
      return;
    }
    toastManager.add({
      type: "success",
      title: actionSuccessLabels(changeRequestTermKind(terminology))[action],
    });
    onSuccess?.(action, result.value);
  };

  return { actionPending, pendingAction, perform };
}

export function usePullRequestCloseBatch(
  onClosed: (entry: EnvironmentPullRequestEntry, reply: PullRequestSummary | undefined) => void,
) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const pending = useRef(new Set<string>());
  const [closingKeys, setClosingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const close = async (entries: readonly EnvironmentPullRequestEntry[]) => {
    const batch = entries.filter((entry) => {
      const key = pullRequestEntryKey(entry);
      if (entry.state !== "open" || pending.current.has(key)) return false;
      pending.current.add(key);
      return true;
    });
    if (batch.length === 0) return;
    setClosingKeys(new Set(pending.current));
    const failures: string[] = [];
    const outcomes = await Promise.all(
      batch.map(async (entry) => {
        const result = await runAction({
          environmentId: entry.environmentId,
          input: {
            projectId: entry.projectId,
            host: entry.host,
            repository: entry.repository,
            number: entry.number,
            action: "close",
          },
        });
        pending.current.delete(pullRequestEntryKey(entry));
        setClosingKeys(new Set(pending.current));
        if (result._tag === "Failure") {
          failures.push(
            `#${entry.number}: ${readableFailure(squashAtomCommandFailure(result), actionFailureHints(changeRequestTermKind(sourceControlClients.get(entry.provider).changeRequest)).close)}`,
          );
          return;
        }
        onClosed(entry, result.value);
        return true;
      }),
    );
    const closed = outcomes.filter(Boolean).length;
    toastManager.add({
      type: failures.length > 0 ? "error" : "success",
      title:
        failures.length > 0
          ? t("Closed {closed} of {total} pull requests", { closed, total: batch.length })
          : tn(closed, "Closed {count} pull request", "Closed {count} pull requests"),
      ...(failures.length > 0 ? { description: failures.slice(0, 3).join("\n") } : {}),
    });
  };
  return { close, closingKeys };
}

export interface PullRequestThreadTask {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

export function writeHandoffToComposer(
  target: ScopedThreadRef | DraftId,
  task: PullRequestThreadTask,
) {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const next = appendHandoff(
    { prompt: draft?.prompt ?? "", reviewComments: draft?.reviewComments ?? [] },
    task,
  );
  store.setPrompt(target, next.prompt);
  store.setReviewComments(target, next.reviewComments);
}

type PreparedCheckout = Awaited<
  ReturnType<ReturnType<typeof usePreparePullRequestThreadAction>["run"]>
>;

/**
 * Moves the draft opened for a checkout onto it once it is ready, keeping whatever the user
 * typed meanwhile. A send from that draft waits for this so it starts in the checkout.
 */
export function prepareDraftCheckout(
  draftId: DraftId,
  checkout: Promise<PreparedCheckout>,
  isCancelled: () => boolean = () => false,
): Promise<PreparedCheckout> {
  const pointed = checkout.then((prepared) => {
    if (isCancelled() || prepared._tag === "Failure") return prepared;
    const { branch, worktreePath, pullRequest } = prepared.value;
    // A waiting send resumes right after this and must render the checkout first.
    flushSync(() =>
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        branch,
        worktreePath,
        envMode: worktreePath === null ? "local" : "worktree",
        workspaceExplicit: true,
        // The draft carries the pull request until its first send makes it a thread, which links it.
        checkoutPullRequest: { url: pullRequest.url, branch },
      }),
    );
    return prepared;
  });
  trackPendingDraftCheckout(draftId, pointed);
  return pointed;
}

export type PullRequestHandoffDetail = Pick<
  PullRequestDetail,
  "projectId" | "workspaceRoot" | "url"
>;

export function usePullRequestHandoffs({
  environmentId,
  detail,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestHandoffDetail | null;
}) {
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });
  // Serialize all handoffs because they check out the same pull request.
  const [handoff, setHandoff] = useState<string | null>(null);
  // Prompt links hand over a URL alone, so the URL is what names the host.
  const terminology = (
    (detail && sourceControlClients.findByChangeRequestUrl(detail.url)) ||
    sourceControlClients.get(undefined)
  ).changeRequest;

  // Questions must not change checkouts or create worktrees.
  const openThreadWithTask = async (
    projectRef: ReturnType<typeof scopeProjectRef>,
    task: PullRequestThreadTask | null,
    opened?: { draftId: DraftId },
  ): Promise<{ draftId: DraftId } | null> => {
    const session =
      opened ??
      (await newThread(projectRef).then(
        (result) => result,
        () => null,
      ));
    if (session === null) return null;
    if (task === null) return session;
    writeHandoffToComposer(session.draftId, task);
    return session;
  };

  const startAsk = async (kind: string, task: PullRequestThreadTask) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    const opened = await openThreadWithTask(projectRef, task);
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: t("Could not open a thread"),
        description: t("Try again from the project, or open a thread first."),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: t("Asked in a thread"),
      description:
        task.prompt.length > 0
          ? t("The question is in the composer. Read it over, then send.")
          : changeRequestTermKind(terminology) === "mr"
            ? t("The merge request is in the composer. Type your question, then send.")
            : changeRequestTermKind(terminology) === "cr"
              ? t("The change request is in the composer. Type your question, then send.")
              : t("The pull request is in the composer. Type your question, then send."),
    });
  };

  const startHandoff = async (
    kind: string,
    task: PullRequestThreadTask | null,
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    // Dismissing the loading toast cancels the handoff before it touches a draft.
    let cancelled = false;
    // Explicit timeouts survive toast updates and would pin the result after loading.
    const toastId = toastManager.add({
      type: "loading",
      title:
        changeRequestTermKind(terminology) === "mr"
          ? t("Preparing the merge request checkout...")
          : changeRequestTermKind(terminology) === "cr"
            ? t("Preparing the change request checkout...")
            : t("Preparing the pull request checkout..."),
      data: {
        onClose: () => {
          cancelled = true;
        },
      },
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // Checkout setup requires the thread to exist first.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (opened === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: t("Could not open a thread for the checkout"),
        description: t("Try again from the project, or open a thread first."),
      });
      return;
    }
    const prepared = await prepareDraftCheckout(
      opened.draftId,
      prepareThread.run({
        reference: detail.url,
        mode,
        threadId: opened.threadId,
      }),
      () => cancelled,
    );
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (prepared._tag === "Failure") {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title:
          changeRequestTermKind(terminology) === "mr"
            ? t("Could not prepare the merge request checkout")
            : changeRequestTermKind(terminology) === "cr"
              ? t("Could not prepare the change request checkout")
              : t("Could not prepare the pull request checkout"),
        description: checkoutFailureDescription(
          isAtomCommandInterrupted(prepared) ? undefined : squashAtomCommandFailure(prepared),
        ),
      });
      return;
    }
    setHandoff(null);
    if (task === null) {
      toastManager.update(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title: mode === "local" ? t("Checked out here") : t("Checked out"),
              description:
                mode === "local"
                  ? changeRequestTermKind(terminology) === "mr"
                    ? t(
                        "This repository is on the merge request's branch, with a thread open on it.",
                      )
                    : changeRequestTermKind(terminology) === "cr"
                      ? t(
                          "This repository is on the change request's branch, with a thread open on it.",
                        )
                      : t(
                          "This repository is on the pull request's branch, with a thread open on it.",
                        )
                  : changeRequestTermKind(terminology) === "mr"
                    ? t("The merge request is in its own worktree, with a thread open on it.")
                    : changeRequestTermKind(terminology) === "cr"
                      ? t("The change request is in its own worktree, with a thread open on it.")
                      : t("The pull request is in its own worktree, with a thread open on it."),
            }
          : offHeadPullRequestCheckoutToast(terminology),
      );
      return;
    }
    await openThreadWithTask(projectRef, task, opened);
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: t("Checkout ready"),
            description: t("The task is in the composer. Read it over, then send."),
          }
        : offHeadPullRequestCheckoutToast(terminology),
    );
  };

  return { handoff, startAsk, startHandoff };
}
