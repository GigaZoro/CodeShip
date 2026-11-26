import { t } from "~/i18n";
import { useAtomValue } from "@effect/atom-react";
import {
  canEditPullRequestMaintainerEdits,
  maintainerEditsChoiceInForce,
  type MaintainerEditsChoice,
} from "@t3tools/client-runtime/pull-request-editing";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  BookOpenIcon,
  CopyIcon,
  HammerIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Trash2Icon,
} from "lucide-react";

import { useId, useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";

import { shortcutLabelForCommand } from "~/keybindings";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { RefreshIcon } from "../ui/refresh-icon";
import { toastManager } from "../ui/toast";
import { ActOnEnvironmentPicker, type PerformPullRequestAction } from "./PullRequestDetailActions";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  pullRequestActionMenuHasGroup,
  readableFailure,
} from "./pullRequestDetail.logic";
import { PullRequestGlyph } from "./pullRequestIcons";
import type { PickableEnvironment } from "./pullRequestProjectAssignment.logic";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

import { changeRequestTermKind } from "./changeRequestTerm";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/** Everything else the reader can do with the pull request, behind the header's overflow button. */
export function PullRequestActionsMenu({
  environmentId,
  reference,
  pullRequestKey,
  detail,
  observedAt,
  terminology,
  threadRef,
  linkThreadRef,
  onThreadPickerOpenChange,
  refreshing,
  refreshFromHost,
  handoff,
  attachesToComposer,
  askAboutPullRequest,
  explainPullRequest,
  canFixFindings,
  startFixFindings,
  handoffLabels,
  canWriteGuide,
  guideRunning,
  guideWritten,
  writeGuide,
  pickableEnvironments,
  actingEnvironmentId,
  onActingEnvironmentChange,
  can,
  autoMergeArmed,
  showsDraftToggle,
  showsMergeNow,
  showsAutoMerge,
  showsMergeMethods,
  allowedMergeMethods,
  selectedMergeMethod,
  onSelectMergeMethod,
  showsDeleteBranch,
  environmentConnected,
  canWriteSourceControl,
  onMaintainerEditsSaved,
  confirmDeleteBranch,
  pendingAction,
  perform,
  openOnHostText,
  copyReference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  pullRequestKey: string;
  detail: Pick<
    PullRequestDetail,
    | "url"
    | "state"
    | "isDraft"
    | "headBranch"
    | "capabilities"
    | "viewerPermissions"
    | "maintainerCanModify"
  >;
  /** When the detail was last read; the detail itself keeps its older stamp across refreshes. */
  observedAt: number | undefined;
  terminology: ChangeRequestTerminology;
  threadRef: ScopedThreadRef | null;
  linkThreadRef: ScopedThreadRef | null;
  onThreadPickerOpenChange: (open: boolean) => void;
  refreshing: boolean;
  refreshFromHost: () => Promise<void>;
  handoff: string | null;
  attachesToComposer: boolean;
  askAboutPullRequest: () => void;
  explainPullRequest: () => void;
  canFixFindings: boolean;
  startFixFindings: () => void;
  handoffLabels: { readonly fixFindings: string };
  canWriteGuide: boolean;
  guideRunning: boolean;
  guideWritten: boolean;
  writeGuide: () => void;
  pickableEnvironments: ReadonlyArray<PickableEnvironment>;
  actingEnvironmentId: EnvironmentId;
  onActingEnvironmentChange: (environmentId: EnvironmentId) => void;
  can: (action: PullRequestAction) => boolean;
  autoMergeArmed: boolean;
  showsDraftToggle: boolean;
  showsMergeNow: boolean;
  showsAutoMerge: boolean;
  showsMergeMethods: boolean;
  allowedMergeMethods: ReadonlyArray<PullRequestMergeMethod>;
  selectedMergeMethod: PullRequestMergeMethod;
  onSelectMergeMethod: (method: PullRequestMergeMethod) => void;
  showsDeleteBranch: boolean;
  environmentConnected: boolean;
  canWriteSourceControl: boolean;
  onMaintainerEditsSaved: () => void;
  confirmDeleteBranch: () => Promise<void>;
  pendingAction: PullRequestAction | null;
  perform: PerformPullRequestAction;
  openOnHostText: string;
  copyReference: (value: string, failureTitle: string) => void;
}) {
  const openLink = useOpenLink(threadRef);

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const actionPending = pendingAction !== null;
  const maintainerEditsHintId = useId();
  const updatePullRequest = useAtomCommand(pullRequestEnvironment.update, {
    reportFailure: false,
  });
  const [maintainerEditsChoice, setMaintainerEditsChoice] = useState<MaintainerEditsChoice | null>(
    null,
  );
  const [maintainerEditsSaving, setMaintainerEditsSaving] = useState(false);
  const maintainerEditsChoiceKept = maintainerEditsChoiceInForce(
    maintainerEditsChoice,
    pullRequestKey,
    observedAt,
    maintainerEditsSaving,
  );
  if (maintainerEditsChoiceKept !== maintainerEditsChoice) {
    setMaintainerEditsChoice(maintainerEditsChoiceKept);
  }
  const maintainerCanModify = maintainerEditsChoiceKept?.value ?? detail.maintainerCanModify;
  const canSaveMaintainerEdits =
    canWriteSourceControl && environmentConnected && !maintainerEditsSaving;
  const saveMaintainerEdits = async (value: boolean) => {
    if (!canSaveMaintainerEdits) return;
    const previousChoice = maintainerEditsChoice;
    setMaintainerEditsChoice({ key: pullRequestKey, observedAt, value });
    setMaintainerEditsSaving(true);
    const result = await updatePullRequest({
      environmentId,
      input: { ...reference, maintainerCanModify: value },
    });
    setMaintainerEditsSaving(false);
    if (result._tag === "Failure") {
      setMaintainerEditsChoice(previousChoice);
      toastManager.add({
        type: "error",
        title: t("Could not save maintainer access"),
        description: readableFailure(squashAtomCommandFailure(result), t("Try again.")),
      });
      return;
    }
    onMaintainerEditsSaved();
  };
  return (
    <Menu>
      <SharedTooltipTrigger
        render={
          <MenuTrigger
            render={
              <Button
                aria-label={
                  refreshing
                    ? changeRequestTermKind(terminology) === "mr"
                      ? t("Refreshing merge request")
                      : changeRequestTermKind(terminology) === "cr"
                        ? t("Refreshing change request")
                        : t("Refreshing pull request")
                    : changeRequestTermKind(terminology) === "mr"
                      ? t("More merge request actions")
                      : changeRequestTermKind(terminology) === "cr"
                        ? t("More change request actions")
                        : t("More pull request actions")
                }
                size="icon-xs"
                variant="ghost-muted"
              />
            }
          >
            {refreshing ? (
              <RefreshIcon refreshing size="md" />
            ) : (
              <MoreHorizontalIcon className="size-4" />
            )}
          </MenuTrigger>
        }
        label={
          refreshing
            ? changeRequestTermKind(terminology) === "mr"
              ? t("Refreshing merge request")
              : changeRequestTermKind(terminology) === "cr"
                ? t("Refreshing change request")
                : t("Refreshing pull request")
            : changeRequestTermKind(terminology) === "mr"
              ? t("More merge request actions")
              : changeRequestTermKind(terminology) === "cr"
                ? t("More change request actions")
                : t("More pull request actions")
        }
      />
      <MenuPopup align="end" side="bottom">
        <PullRequestThreadLinks
          display="menu-item"
          environmentId={environmentId}
          reference={reference}
          url={detail.url}
          threadRef={linkThreadRef}
          onPickerOpenChange={onThreadPickerOpenChange}
        />
        <MenuItem disabled={refreshing} onClick={() => void refreshFromHost()}>
          <RefreshIcon size="sm" refreshing={refreshing} />
          {t("Refresh")}
        </MenuItem>
        <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
          <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>{handoff === "ask" ? t("Opening...") : t("Ask a question")}</span>
            <span className="text-xs text-muted-foreground">
              {attachesToComposer
                ? changeRequestTermKind(terminology) === "mr"
                  ? t("Adds the merge request to this thread's composer.")
                  : changeRequestTermKind(terminology) === "cr"
                    ? t("Adds the change request to this thread's composer.")
                    : t("Adds the pull request to this thread's composer.")
                : changeRequestTermKind(terminology) === "mr"
                  ? t("Opens a thread that knows which merge request you mean.")
                  : changeRequestTermKind(terminology) === "cr"
                    ? t("Opens a thread that knows which change request you mean.")
                    : t("Opens a thread that knows which pull request you mean.")}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
          <BookOpenIcon className="mt-1 size-3.5 shrink-0 self-start" />
          <span className="flex min-w-0 flex-col">
            <span>
              {handoff === "explain"
                ? t("Opening...")
                : changeRequestTermKind(terminology) === "mr"
                  ? t("Explain this MR")
                  : changeRequestTermKind(terminology) === "cr"
                    ? t("Explain this change request")
                    : t("Explain this PR")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("A walk through the diff and what to read closely.")}
            </span>
          </span>
        </MenuItem>
        <MenuItem disabled={handoff !== null || !canFixFindings} onClick={startFixFindings}>
          <HammerIcon className="size-3.5" />
          {handoff === "findings" ? t("Preparing...") : handoffLabels.fixFindings}
        </MenuItem>
        {canWriteGuide ? (
          <MenuItem disabled={guideRunning} onClick={writeGuide}>
            <ScrollTextIcon className="size-3.5" />
            {guideRunning
              ? t("Writing guide...")
              : !guideWritten
                ? t("Write guide")
                : t("Rewrite guide")}
          </MenuItem>
        ) : null}
        {pickableEnvironments.length > 0 ? (
          <ActOnEnvironmentPicker
            environments={pickableEnvironments}
            value={actingEnvironmentId}
            onChange={onActingEnvironmentChange}
            disabled={handoff !== null}
          />
        ) : null}
        <MenuSeparator />
        {canEditPullRequestMaintainerEdits(detail) ? (
          <>
            <MenuCheckboxItem
              variant="icon"
              checked={maintainerCanModify === true}
              disabled={!canSaveMaintainerEdits}
              closeOnClick={false}
              aria-label={t("Allow edits from maintainers")}
              aria-describedby={maintainerEditsHintId}
              onCheckedChange={(value) => void saveMaintainerEdits(value)}
            >
              <span className="flex max-w-xs flex-col gap-0.5">
                <span>{t("Allow edits from maintainers")}</span>
                <span id={maintainerEditsHintId} className="text-xs text-muted-foreground">
                  {t(
                    "Maintainers can push to this branch. If your fork has workflows, this can also give access to its secrets.",
                  )}
                </span>
                {maintainerEditsSaving ? (
                  <span role="status" className="text-xs text-muted-foreground">
                    {t("Saving…")}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
            <MenuSeparator />
          </>
        ) : null}
        {detail.state === "open" ? (
          <>
            {showsDraftToggle ? (
              <MenuItem
                disabled={actionPending}
                onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
              >
                {detail.isDraft ? (
                  <PullRequestGlyph.pullRequest className="size-3.5" />
                ) : (
                  <PullRequestGlyph.draft className="size-3.5" />
                )}
                {detail.isDraft ? t("Ready for review") : t("Convert to draft")}
              </MenuItem>
            ) : null}
            {showsMergeNow ? (
              <MenuItem
                closeOnClick={inlineConfirm.isArmed("merge")}
                aria-label={inlineConfirm.isArmed("merge") ? t("Confirm merge?") : t("Merge now")}
                disabled={actionPending}
                {...inlineConfirm.props("merge", () => void perform("merge", selectedMergeMethod))}
              >
                <PullRequestGlyph.merged className="size-3.5" />
                {inlineConfirm.isArmed("merge") ? t("Confirm merge?") : t("Merge now")}
              </MenuItem>
            ) : null}
            {autoMergeArmed && can("disable-auto-merge") ? (
              <MenuItem disabled={actionPending} onClick={() => void perform("disable-auto-merge")}>
                <PullRequestGlyph.merged className="size-3.5" />
                {t("Disable auto-merge")}
              </MenuItem>
            ) : showsAutoMerge ? (
              <MenuItem
                closeOnClick={inlineConfirm.isArmed("enable-auto-merge")}
                aria-label={
                  inlineConfirm.isArmed("enable-auto-merge")
                    ? t("Confirm auto-merge?")
                    : t("Enable auto-merge")
                }
                disabled={actionPending}
                {...inlineConfirm.props(
                  "enable-auto-merge",
                  () => void perform("enable-auto-merge", selectedMergeMethod),
                )}
              >
                <PullRequestGlyph.merged className="size-3.5" />
                {inlineConfirm.isArmed("enable-auto-merge")
                  ? t("Confirm auto-merge?")
                  : t("Enable auto-merge")}
              </MenuItem>
            ) : null}
            {showsMergeMethods ? (
              <>
                {showsDraftToggle || showsMergeNow || showsAutoMerge ? <MenuSeparator /> : null}
                <MenuRadioGroup
                  value={selectedMergeMethod}
                  onValueChange={(method) => onSelectMergeMethod(method as PullRequestMergeMethod)}
                >
                  {allowedMergeMethods.map((method) => (
                    <MenuRadioItem
                      key={method}
                      value={method}
                      disabled={actionPending}
                      closeOnClick
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <PullRequestGlyph.merged className="size-3.5" />
                        <span>{t(PULL_REQUEST_MERGE_METHOD_LABELS[method])}</span>
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </>
            ) : null}
            {pullRequestActionMenuHasGroup(
              showsDraftToggle,
              showsAutoMerge || showsMergeNow,
              showsMergeMethods,
            ) ? (
              <MenuSeparator />
            ) : null}
          </>
        ) : null}
        <MenuItem onClick={(event) => void openLink(detail.url, { event }).catch(console.error)}>
          <ArrowUpRightIcon className="size-3.5" />
          {openOnHostText}
        </MenuItem>
        <MenuItem
          onClick={() =>
            copyReference(
              detail.url,
              changeRequestTermKind(terminology) === "mr"
                ? t("Failed to copy MR link")
                : changeRequestTermKind(terminology) === "cr"
                  ? t("Failed to copy change request link")
                  : t("Failed to copy PR link"),
            )
          }
        >
          <LinkIcon className="size-3.5" />
          {t("Copy link")}
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "thread.copyReference")}
          </MenuShortcut>
        </MenuItem>
        <MenuItem
          onClick={() =>
            copyReference(
              `#${reference.number}`,
              changeRequestTermKind(terminology) === "mr"
                ? t("Failed to copy MR number")
                : changeRequestTermKind(terminology) === "cr"
                  ? t("Failed to copy change request number")
                  : t("Failed to copy PR number"),
            )
          }
        >
          <CopyIcon className="size-3.5" />
          {changeRequestTermKind(terminology) === "mr"
            ? t("Copy MR number")
            : changeRequestTermKind(terminology) === "cr"
              ? t("Copy change request number")
              : t("Copy PR number")}
          <MenuShortcut>
            {shortcutLabelForCommand(keybindings, "pullRequest.copyNumber")}
          </MenuShortcut>
        </MenuItem>
        {detail.state === "open" && can("close") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("close")}
              aria-label={
                inlineConfirm.isArmed("close")
                  ? t("Confirm close?")
                  : changeRequestTermKind(terminology) === "mr"
                    ? t("Close merge request")
                    : changeRequestTermKind(terminology) === "cr"
                      ? t("Close change request")
                      : t("Close pull request")
              }
              variant="destructive"
              disabled={actionPending}
              {...inlineConfirm.props("close", () => void perform("close"))}
            >
              <PullRequestGlyph.closed className="size-3.5" />
              {inlineConfirm.isArmed("close")
                ? t("Confirm close?")
                : changeRequestTermKind(terminology) === "mr"
                  ? t("Close merge request")
                  : changeRequestTermKind(terminology) === "cr"
                    ? t("Close change request")
                    : t("Close pull request")}
            </MenuItem>
          </>
        ) : detail.state === "closed" && can("reopen") ? (
          <>
            <MenuSeparator />
            <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
              <PullRequestGlyph.reopen className="size-3.5" />
              {changeRequestTermKind(terminology) === "mr"
                ? t("Reopen merge request")
                : changeRequestTermKind(terminology) === "cr"
                  ? t("Reopen change request")
                  : t("Reopen pull request")}
            </MenuItem>
          </>
        ) : detail.state === "merged" && can("revert") ? (
          <>
            <MenuSeparator />
            <MenuItem
              closeOnClick={inlineConfirm.isArmed("revert")}
              aria-label={
                inlineConfirm.isArmed("revert") ? t("Confirm revert?") : t("Revert changes")
              }
              variant={inlineConfirm.isArmed("revert") ? "destructive" : "default"}
              disabled={actionPending}
              {...inlineConfirm.props("revert", () => void perform("revert"))}
            >
              <RotateCcwIcon className="size-3.5" />
              {inlineConfirm.isArmed("revert") ? t("Confirm revert?") : t("Revert changes")}
            </MenuItem>
          </>
        ) : null}
        {showsDeleteBranch ? (
          <>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={actionPending || !environmentConnected}
              onClick={() => void confirmDeleteBranch()}
            >
              <Trash2Icon className="mt-1 size-3.5 shrink-0 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>
                  {pendingAction === "delete-branch" ? t("Deleting branch...") : t("Delete branch")}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {environmentConnected ? detail.headBranch : t("Reconnect to delete this branch")}
                </span>
              </span>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
