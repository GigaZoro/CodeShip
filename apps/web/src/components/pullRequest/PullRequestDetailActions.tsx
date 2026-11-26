import { t } from "~/i18n";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderGit2Icon, GitBranchIcon, PlayIcon } from "lucide-react";

import type { ReactNode } from "react";

import { AnimatedWidth } from "~/components/AnimatedWidth";
import { cn } from "~/lib/utils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import type { resolvePullRequestPrimaryControl } from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { resolvePullRequestState } from "./pullRequestPresentation";
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

import type { ChangeRequestTermKind } from "./changeRequestTerm";

export type PerformPullRequestAction = (
  action: PullRequestAction,
  method?: PullRequestMergeMethod,
  updateMethod?: PullRequestUpdateMethod,
) => Promise<boolean>;

export function ActOnEnvironmentPicker({
  environments,
  value,
  onChange,
  disabled,
}: {
  environments: ReadonlyArray<PickableEnvironment>;
  value: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
  disabled: boolean;
}) {
  return (
    <>
      <MenuSeparator />
      <MenuRadioGroup
        value={value}
        onValueChange={(environmentId) => onChange(environmentId as EnvironmentId)}
      >
        {environments.map((environment) => (
          <MenuRadioItem
            key={environment.environmentId}
            value={environment.environmentId}
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                kind={environment.machine ?? "server"}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{environment.label}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

export function PullRequestCheckoutMenu({
  handoff,
  checkoutRoot,
  canPrepareWorktree,
  canCheckoutHere,
  onCheckout,
  pickableEnvironments,
  actingEnvironmentId,
  onActingEnvironmentChange,
  term,
}: {
  handoff: string | null;
  checkoutRoot: string | null;
  canPrepareWorktree: boolean;
  canCheckoutHere: boolean;
  onCheckout: (mode: "worktree" | "local") => void;
  pickableEnvironments: ReadonlyArray<PickableEnvironment>;
  actingEnvironmentId: EnvironmentId;
  onActingEnvironmentChange: (environmentId: EnvironmentId) => void;
  term: ChangeRequestTermKind;
}) {
  return (
    <Menu>
      <SharedTooltipTrigger
        render={
          <MenuTrigger
            disabled={handoff !== null || checkoutRoot === null}
            render={
              <Button
                size="xs"
                variant="outline"
                aria-label={handoff?.startsWith("checkout") ? t("Checking out...") : t("Check out")}
              >
                <GitBranchIcon aria-hidden className="size-3.5" />
                <span className="@max-[35rem]/pr-header:hidden">
                  {handoff?.startsWith("checkout") ? t("Checking out...") : t("Check out")}
                </span>
                <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
              </Button>
            }
          />
        }
        label={
          <>
            {term === "mr"
              ? t("Check out this merge request")
              : term === "cr"
                ? t("Check out this change request")
                : t("Check out this pull request")}
          </>
        }
      />
      <MenuPopup align="end" side="bottom">
        <MenuItem disabled={!canPrepareWorktree} onClick={() => onCheckout("worktree")}>
          <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{t("In a separate worktree")}</span>
            <span className="text-xs text-muted-foreground">
              {t("Its own folder and thread. Nothing you have open moves.")}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={!canCheckoutHere} onClick={() => onCheckout("local")}>
          <FolderGit2Icon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{t("In this repository")}</span>
            <span className="text-xs text-muted-foreground">
              {t("Switches the branch you are working in.")}
            </span>
          </span>
        </MenuItem>
        {pickableEnvironments.length > 0 ? (
          <ActOnEnvironmentPicker
            environments={pickableEnvironments}
            value={actingEnvironmentId}
            onChange={onActingEnvironmentChange}
            disabled={handoff !== null}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

export function PullRequestResolveConflictsButton({
  handoff,
  unavailable,
  onResolve,
}: {
  handoff: string | null;
  unavailable: boolean;
  onResolve: () => void;
}) {
  return (
    <SharedTooltipTrigger
      render={
        <span className="inline-flex shrink-0">
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={handoff !== null || unavailable}
            onClick={onResolve}
            aria-label={handoff === "conflicts" ? t("Preparing...") : t("Resolve conflicts")}
          >
            <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
            <span className="@max-[30rem]/pr-header:hidden">
              {handoff === "conflicts" ? t("Preparing...") : t("Resolve conflicts")}
            </span>
          </Button>
        </span>
      }
      label={handoff === "conflicts" ? t("Preparing...") : t("Resolve conflicts")}
    />
  );
}

/** The header's one prominent control, which depends on where the pull request stands. */
export function PullRequestPrimaryAction({
  pullRequestKey,
  primaryAction,
  mergeBlockedReason,
  autoMergeArmed,
  armedAutoMergeLabel,
  pendingAutoMergeLabel,
  selectedMergeMethod,
  selectedMergeMethodLabel,
  statePresentation,
  pendingAction,
  perform,
  resolveConflicts,
}: {
  pullRequestKey: string;
  primaryAction: ReturnType<typeof resolvePullRequestPrimaryControl> | null;
  mergeBlockedReason: string | null;
  autoMergeArmed: boolean;
  armedAutoMergeLabel: string;
  pendingAutoMergeLabel: string;
  selectedMergeMethod: PullRequestMergeMethod;
  selectedMergeMethodLabel: string;
  statePresentation: ReturnType<typeof resolvePullRequestState> | null;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  resolveConflicts: ReactNode;
}) {
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <>
      {autoMergeArmed && primaryAction !== "auto-merge-armed" ? (
        <SharedTooltipTrigger
          render={
            <Badge size="control" variant="info" role="img" aria-label={armedAutoMergeLabel}>
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
            </Badge>
          }
          label={t("{label}: the host will merge this on its own once its requirements are met", {
            label: armedAutoMergeLabel,
          })}
        />
      ) : null}
      {primaryAction === "resolve" ? (
        resolveConflicts
      ) : primaryAction === "ready" ? (
        <SharedTooltipTrigger
          render={
            <span className="inline-flex shrink-0">
              <Button
                size="xs"
                variant="default"
                disabled={actionPending}
                onClick={() => void perform("ready")}
                aria-label={t("Ready for review")}
              >
                <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
                <span className="@max-[30rem]/pr-header:hidden">{t("Ready for review")}</span>
              </Button>
            </span>
          }
          label={<>{t("Ready for review")}</>}
        />
      ) : primaryAction === "enable-auto-merge" ? (
        <SharedTooltipTrigger
          render={
            <span className="inline-flex shrink-0">
              <Button
                size="xs"
                variant="default"
                disabled={actionPending}
                aria-disabled={mergeBlockedReason !== null || undefined}
                aria-description={mergeBlockedReason ?? undefined}
                {...(mergeBlockedReason === null
                  ? inlineConfirm.props(
                      "enable-auto-merge",
                      () => void perform("enable-auto-merge", selectedMergeMethod),
                    )
                  : {})}
                aria-label={
                  pendingAction === "enable-auto-merge"
                    ? t("Enabling...")
                    : inlineConfirm.isArmed("enable-auto-merge")
                      ? t("Confirm auto-merge?")
                      : pendingAutoMergeLabel
                }
              >
                {inlineConfirm.isArmed("enable-auto-merge") ? (
                  <CheckIcon aria-hidden className="size-3.5" />
                ) : (
                  <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                )}
                <AnimatedWidth className="@max-[30rem]/pr-header:hidden">
                  <span className="grid">
                    <span aria-hidden className="invisible col-start-1 row-start-1">
                      {pendingAutoMergeLabel}
                    </span>
                    <span className="col-start-1 row-start-1">
                      {pendingAction === "enable-auto-merge"
                        ? t("Enabling...")
                        : inlineConfirm.isArmed("enable-auto-merge")
                          ? t("Confirm auto-merge?")
                          : pendingAutoMergeLabel}
                    </span>
                  </span>
                </AnimatedWidth>
              </Button>
            </span>
          }
          label={
            mergeBlockedReason ??
            (pendingAction === "enable-auto-merge"
              ? t("Enabling...")
              : inlineConfirm.isArmed("enable-auto-merge")
                ? t("Confirm auto-merge?")
                : pendingAutoMergeLabel)
          }
        />
      ) : primaryAction === "auto-merge-armed" ? (
        <SharedTooltipTrigger
          render={
            <Badge size="control" variant="info" role="img" aria-label={armedAutoMergeLabel}>
              <PullRequestGlyph.merged aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
            </Badge>
          }
          label={t("{label}: the host will merge this on its own once its requirements are met", {
            label: armedAutoMergeLabel,
          })}
        />
      ) : primaryAction === "merge" ? (
        <SharedTooltipTrigger
          render={
            <span className="inline-flex shrink-0">
              <Button
                size="xs"
                variant="default"
                disabled={actionPending}
                aria-disabled={mergeBlockedReason !== null || undefined}
                aria-description={mergeBlockedReason ?? undefined}
                {...(mergeBlockedReason === null
                  ? inlineConfirm.props("merge", () => void perform("merge", selectedMergeMethod))
                  : {})}
                aria-label={
                  pendingAction === "merge"
                    ? t("Merging...")
                    : inlineConfirm.isArmed("merge")
                      ? t("Confirm merge?")
                      : selectedMergeMethodLabel
                }
              >
                {inlineConfirm.isArmed("merge") ? (
                  <CheckIcon aria-hidden className="size-3.5" />
                ) : (
                  <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                )}
                <AnimatedWidth className="@max-[30rem]/pr-header:hidden">
                  <span className="grid">
                    <span aria-hidden className="invisible col-start-1 row-start-1">
                      {selectedMergeMethodLabel}
                    </span>
                    <span className="col-start-1 row-start-1">
                      {pendingAction === "merge"
                        ? t("Merging...")
                        : inlineConfirm.isArmed("merge")
                          ? t("Confirm merge?")
                          : selectedMergeMethodLabel}
                    </span>
                  </span>
                </AnimatedWidth>
              </Button>
            </span>
          }
          label={
            mergeBlockedReason ??
            (pendingAction === "merge"
              ? t("Merging...")
              : inlineConfirm.isArmed("merge")
                ? t("Confirm merge?")
                : selectedMergeMethodLabel)
          }
        />
      ) : (primaryAction === "merged" || primaryAction === "closed") &&
        statePresentation !== null ? (
        <Badge size="control" variant="outline">
          <span className={cn("flex items-center gap-1", statePresentation.toneClassName)}>
            <statePresentation.Icon className="size-3.5" />
            {statePresentation.label}
          </span>
        </Badge>
      ) : null}
    </>
  );
}

export function PullRequestApproveWorkflowsButton({
  pullRequestKey,
  pendingAction,
  perform,
}: {
  pullRequestKey: string;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
}) {
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  return (
    <SharedTooltipTrigger
      render={
        <span className="ml-auto inline-flex shrink-0">
          <Button
            size="xs"
            variant="warning-outline"
            disabled={actionPending}
            {...inlineConfirm.props("approve-workflows", () => void perform("approve-workflows"))}
            aria-label={
              pendingAction === "approve-workflows"
                ? t("Approving...")
                : inlineConfirm.isArmed("approve-workflows")
                  ? t("Confirm approve?")
                  : t("Approve workflows to run")
            }
          >
            <PlayIcon aria-hidden className="size-3.5" />
            <span className="inline-grid">
              <span aria-hidden className="invisible col-start-1 row-start-1">
                {t("Approve workflows to run")}
              </span>
              <span aria-hidden className="invisible col-start-1 row-start-1">
                {t("Confirm approve?")}
              </span>
              <span className="col-start-1 row-start-1">
                {pendingAction === "approve-workflows"
                  ? t("Approving...")
                  : inlineConfirm.isArmed("approve-workflows")
                    ? t("Confirm approve?")
                    : t("Approve workflows to run")}
              </span>
            </span>
          </Button>
        </span>
      }
      label={
        pendingAction === "approve-workflows"
          ? t("Approving...")
          : inlineConfirm.isArmed("approve-workflows")
            ? t("Confirm approve?")
            : t("Approve workflows to run")
      }
    />
  );
}
