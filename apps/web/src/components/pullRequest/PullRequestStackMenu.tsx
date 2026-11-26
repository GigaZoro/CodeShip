import { t, tn } from "~/i18n";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStack,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ClockIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger, MenuItem, MenuGroup, MenuSeparator } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import type { ChangeRequestTerminology } from "~/sourceControlPresentation";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestStackLayerContent } from "./PullRequestStackLayerContent";
import { PullRequestGlyph } from "./pullRequestIcons";
import { mergeHeadPin, readableFailure } from "./pullRequestDetail.logic";

import { changeRequestTermKind } from "./changeRequestTerm";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

export function PullRequestStackMenu({
  hostLabel,
  terminology,
  stack,
  reference,
  environmentId,
  shownHeadSha,
  stale,
  canMerge,
  canRebase,
  canAutoMerge,
  preferAutoMerge,
  autoMergeArmed,
  canCancelAutoMerge,
  mergeMethod,
  onSelect,
  onActed,
  notice,
  onRetry,
}: {
  hostLabel: string;
  terminology: ChangeRequestTerminology;
  notice?: string | null;
  onRetry?: (() => void) | undefined;
  stack: PullRequestStack;
  reference: PullRequestRef;
  environmentId: EnvironmentId;
  /** The head of `reference` the reader was shown; the stack read can run ahead of it. */
  shownHeadSha: string | undefined;
  stale: boolean;
  canMerge: boolean;
  canRebase: boolean;
  /** The host can arm auto-merge for this layer and the open layers below it. */
  canAutoMerge: boolean;
  /** Checks are still running, so arming auto-merge leads over merging now. */
  preferAutoMerge: boolean;
  /** This layer carries a stack auto-merge request, which covers the layers below it. */
  autoMergeArmed: boolean;
  canCancelAutoMerge: boolean;
  mergeMethod: PullRequestMergeMethod;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  onActed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<
    "merge" | "enable-auto-merge" | "update-branch" | null
  >(null);
  const [pending, setPending] = useState(false);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const top = stack.layers.at(-1);
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const hasClosed = unmerged.some((layer) => layer.state !== "open");
  const position = stack.layers.findIndex((layer) => layer.number === reference.number) + 1;
  const mergeLayers = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const selectedLayer = stack.layers[position - 1];
  const mergeHasClosed = mergeLayers.some((layer) => layer.state !== "open");
  const expectedStackHeads = unmerged.flatMap((layer) =>
    layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
  );
  const hasUnknownHead = expectedStackHeads.length !== unmerged.length;
  const mergeDisabled =
    pending ||
    stale ||
    selectedLayer?.state !== "open" ||
    mergeLayers.some((layer) => !layer.headSha) ||
    mergeHasClosed ||
    mergeLayers.length === 0 ||
    mergeLayers.some((layer) => layer.isDraft);
  const staleReason = notice ?? t("Checking the stack with the host…");
  const rebaseDisabled = pending || stale || hasUnknownHead || hasClosed || unmerged.length === 0;
  const run = async () => {
    if (
      pending ||
      !confirmation ||
      (confirmation === "merge"
        ? !canMerge || mergeDisabled
        : confirmation === "enable-auto-merge"
          ? !canAutoMerge || autoMergeArmed || mergeDisabled
          : !canRebase || rebaseDisabled)
    )
      return;
    const action = confirmation;
    const merging = action !== "update-branch";
    const target = merging ? selectedLayer : top;
    if (!target?.headSha) return;
    const actionHeads = (merging ? mergeLayers : unmerged).flatMap((layer) =>
      layer.headSha ? [{ number: layer.number, headSha: layer.headSha }] : [],
    );
    setPending(true);
    setConfirmation(null);
    const toastId = toastManager.add({
      type: "loading",
      title:
        action === "merge"
          ? t("Merging stack...")
          : action === "enable-auto-merge"
            ? t("Enabling stack auto-merge...")
            : t("Rebasing stack..."),
    });
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        number: target.number,
        stackNumber: stack.number,
        expectedStackHeads: actionHeads,
        ...mergeHeadPin(action, shownHeadSha),
        action,
        ...(merging ? { mergeMethod } : { updateMethod: "rebase" }),
      },
    });
    setPending(false);
    onActed();
    if (result._tag === "Failure") {
      toastManager.update(toastId, {
        type: "error",
        title:
          action === "merge"
            ? t("Could not merge the stack")
            : action === "enable-auto-merge"
              ? t("Could not enable stack auto-merge")
              : t("Could not rebase the stack"),
        description: readableFailure(
          squashAtomCommandFailure(result),
          merging
            ? t(
                "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
              )
            : t(
                "The host refused the rebase. A rebase stops at the first commit that does not apply cleanly.",
              ),
        ),
      });
    } else {
      toastManager.update(toastId, {
        type: "success",
        title:
          action === "merge"
            ? t("Stack merge request completed")
            : action === "enable-auto-merge"
              ? t("Stack auto-merge enabled")
              : t("Stack rebased"),
        description:
          action === "merge"
            ? t("{host} merged the stack or added it to its merge queue.", { host: hostLabel })
            : action === "enable-auto-merge"
              ? t("{host} merges the stack through #{number} once its requirements are met.", {
                  host: hostLabel,
                  number: reference.number,
                })
              : undefined,
      });
    }
  };
  const cancelAutoMerge = async () => {
    if (pending || !canCancelAutoMerge) return;
    setPending(true);
    const result = await runAction({
      environmentId,
      input: { ...reference, stackNumber: stack.number, action: "disable-auto-merge" },
    });
    setPending(false);
    onActed();
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: t("Could not cancel stack auto-merge"),
        description: readableFailure(
          squashAtomCommandFailure(result),
          t("The host refused to cancel auto-merge. Refresh and try again."),
        ),
      });
    }
  };
  const confirmationLayers = confirmation === "update-branch" ? unmerged : mergeLayers;
  const leadsWithAutoMerge = canAutoMerge && preferAutoMerge;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <SharedTooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={t("Stack {number}, layer {position} of {size}", {
                    number: stack.number,
                    position,
                    size: stack.layers.length,
                  })}
                />
              }
            >
              <PullRequestGlyph.stack aria-hidden className="size-3.5" /> {position}/
              {stack.layers.length}
              {onRetry ? <TriangleAlertIcon aria-hidden className="size-3 text-warning" /> : null}
            </MenuTrigger>
          }
          label={
            <>
              {t("View stack #{number}, layer {position} of {length}", {
                number: stack.number,
                position,
                length: stack.layers.length,
              })}
              {notice ? ` · ${notice}` : null}
            </>
          }
        />
        <MenuPopup align="start">
          <MenuGroup>
            <PullRequestStackHeader number={stack.number} notice={notice} stale={!!onRetry} />
            {onRetry ? <MenuItem onClick={onRetry}>{t("Retry stack refresh")}</MenuItem> : null}
            <PullRequestStackLayers
              stack={stack}
              reference={reference}
              pending={pending}
              onSelect={
                onSelect
                  ? (target) => {
                      setOpen(false);
                      onSelect(target);
                    }
                  : undefined
              }
            />
          </MenuGroup>
          {canMerge || canRebase || canAutoMerge || canCancelAutoMerge ? (
            <>
              <MenuSeparator />
              {canMerge && !autoMergeArmed ? (
                <MenuItem disabled={mergeDisabled} onClick={() => setConfirmation("merge")}>
                  <PullRequestGlyph.merged aria-hidden />
                  {t("Merge stack ({length})", { length: mergeLayers.length })}
                </MenuItem>
              ) : null}
              {canAutoMerge && !autoMergeArmed ? (
                <MenuItem
                  disabled={mergeDisabled}
                  onClick={() => setConfirmation("enable-auto-merge")}
                >
                  <ClockIcon aria-hidden />
                  {t("Auto-merge stack ({length})", { length: mergeLayers.length })}
                </MenuItem>
              ) : null}
              {autoMergeArmed && canCancelAutoMerge ? (
                <MenuItem disabled={pending} onClick={() => void cancelAutoMerge()}>
                  <XIcon aria-hidden />
                  {t("Cancel stack auto-merge")}
                </MenuItem>
              ) : null}
              {canRebase ? (
                <MenuItem
                  disabled={rebaseDisabled}
                  onClick={() => setConfirmation("update-branch")}
                >
                  <RefreshCwIcon aria-hidden />
                  {t("Rebase stack")}
                </MenuItem>
              ) : null}
              {mergeHasClosed || mergeLayers.some((layer) => layer.isDraft) ? (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {t("Every layer being merged must be open and ready for review.")}
                </p>
              ) : null}
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {(leadsWithAutoMerge || canMerge) && !autoMergeArmed && selectedLayer?.state === "open" ? (
        <SharedTooltipTrigger
          render={
            <span className="inline-flex">
              <Button
                variant="default"
                size="xs"
                disabled={mergeDisabled && !stale}
                aria-disabled={mergeDisabled || undefined}
                aria-description={stale ? staleReason : undefined}
                onClick={
                  mergeDisabled
                    ? undefined
                    : () => setConfirmation(leadsWithAutoMerge ? "enable-auto-merge" : "merge")
                }
              >
                {leadsWithAutoMerge ? (
                  <ClockIcon aria-hidden className="size-3.5" />
                ) : (
                  <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                )}
                {leadsWithAutoMerge ? t("Auto-merge stack") : t("Merge stack")}
              </Button>
            </span>
          }
          label={
            stale
              ? staleReason
              : changeRequestTermKind(terminology) === "mr"
                ? tn(
                    mergeLayers.length,
                    "Merge stack through #{number} into {base} ({count} merge request)",
                    "Merge stack through #{number} into {base} ({count} merge requests)",
                    { number: reference.number, base: stack.base },
                  )
                : changeRequestTermKind(terminology) === "cr"
                  ? tn(
                      mergeLayers.length,
                      "Merge stack through #{number} into {base} ({count} change request)",
                      "Merge stack through #{number} into {base} ({count} change requests)",
                      { number: reference.number, base: stack.base },
                    )
                  : tn(
                      mergeLayers.length,
                      "Merge stack through #{number} into {base} ({count} pull request)",
                      "Merge stack through #{number} into {base} ({count} pull requests)",
                      { number: reference.number, base: stack.base },
                    )
          }
        />
      ) : null}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(value) => {
          if (!value) setConfirmation(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmation === "merge"
                ? changeRequestTermKind(terminology) === "mr"
                  ? tn(
                      mergeLayers.length,
                      "Merge {count} merge request?",
                      "Merge {count} merge requests?",
                    )
                  : changeRequestTermKind(terminology) === "cr"
                    ? tn(
                        mergeLayers.length,
                        "Merge {count} change request?",
                        "Merge {count} change requests?",
                      )
                    : tn(
                        mergeLayers.length,
                        "Merge {count} pull request?",
                        "Merge {count} pull requests?",
                      )
                : confirmation === "enable-auto-merge"
                  ? changeRequestTermKind(terminology) === "mr"
                    ? tn(
                        mergeLayers.length,
                        "Auto-merge {count} merge request?",
                        "Auto-merge {count} merge requests?",
                      )
                    : changeRequestTermKind(terminology) === "cr"
                      ? tn(
                          mergeLayers.length,
                          "Auto-merge {count} change request?",
                          "Auto-merge {count} change requests?",
                        )
                      : tn(
                          mergeLayers.length,
                          "Auto-merge {count} pull request?",
                          "Auto-merge {count} pull requests?",
                        )
                  : changeRequestTermKind(terminology) === "mr"
                    ? tn(
                        unmerged.length,
                        "Rebase {count} merge request?",
                        "Rebase {count} merge requests?",
                      )
                    : changeRequestTermKind(terminology) === "cr"
                      ? tn(
                          unmerged.length,
                          "Rebase {count} change request?",
                          "Rebase {count} change requests?",
                        )
                      : tn(
                          unmerged.length,
                          "Rebase {count} pull request?",
                          "Rebase {count} pull requests?",
                        )}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "merge"
                ? t(
                    "Merge #{number} and its unmerged layers below into {base} using {method}. {host} checks their rules before merging or queueing them and rebases the remaining stack after merging.",
                    {
                      number: reference.number,
                      base: stack.base,
                      method: mergeMethod,
                      host: hostLabel,
                    },
                  )
                : confirmation === "enable-auto-merge"
                  ? t(
                      "Merge #{number} and its unmerged layers below into {base} using {method} once every one of them meets the requirements on {host}. This may happen immediately.",
                      {
                        number: reference.number,
                        base: stack.base,
                        method: mergeMethod,
                        host: hostLabel,
                      },
                    )
                  : t(
                      "Rebase the remote branches from bottom to top onto {base}. This rewrites branch history and may restart checks. If a layer fails, earlier updates remain.",
                      { base: stack.base },
                    )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {confirmationLayers.map((layer) => (
                <li
                  key={layer.number}
                  className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2"
                >
                  <PullRequestStackLayerContent layer={layer} compact />
                </li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)}>
              {t("Cancel")}
            </Button>
            <Button onClick={() => void run()}>
              {confirmation === "merge"
                ? t("Merge stack")
                : confirmation === "enable-auto-merge"
                  ? t("Enable auto-merge")
                  : t("Rebase stack")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
