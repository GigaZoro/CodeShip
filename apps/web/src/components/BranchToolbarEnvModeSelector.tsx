import { t } from "~/i18n";
import { ComposerSelectControl } from "./chat/ComposerControl";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useId, type MouseEvent as ReactMouseEvent } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveForcedWorktreeLabel,
  resolveLockedWorkspaceLabel,
  resolveWorkspaceChoice,
  type EnvMode,
  type WorkspaceChoice,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onWorkspaceChoice: (choice: WorkspaceChoice) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onWorkspaceChoice,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const lockedReasonId = useId();
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.workspace",
  );
  const envModeItems: Array<{ value: WorkspaceChoice; label: string }> = [
    { value: "local", label: resolveEnvModeLabel("local") },
    ...(activeWorktreePath
      ? [
          {
            value: "current-worktree" as const,
            label: resolveCurrentWorkspaceLabel(activeWorktreePath),
          },
        ]
      : []),
    { value: "worktree", label: resolveEnvModeLabel("worktree") },
    ...(previousWorktreeLabel
      ? [{ value: "previous-worktree" as const, label: previousWorktreeLabel }]
      : []),
  ];

  const stopContextMenuMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
    }
  };

  if (envLocked || forceNewWorktree) {
    const lockedLabel = forceNewWorktree
      ? resolveForcedWorktreeLabel()
      : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode);
    const lockedReason = forceNewWorktree ? t("Each model starts in its own worktree.") : null;
    const lockedRow = (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1.5 border border-transparent px-1.75 font-normal text-muted-foreground text-sm sm:h-6 sm:text-xs"
        tabIndex={lockedReason ? 0 : undefined}
        aria-describedby={lockedReason ? lockedReasonId : undefined}
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3" />
        ) : effectiveEnvMode === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <ComposerContextLabel>{lockedLabel}</ComposerContextLabel>
        {lockedReason ? (
          <span id={lockedReasonId} className="sr-only">
            {lockedReason}
          </span>
        ) : null}
      </span>
    );

    return (
      <Tooltip>
        <TooltipTrigger render={lockedRow} />
        <TooltipPopup>{lockedReason ?? lockedLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={resolveWorkspaceChoice({ activeWorktreePath, effectiveEnvMode })}
      onValueChange={(value: WorkspaceChoice | null) => {
        if (value !== null) onWorkspaceChoice(value);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              size="xs"
              className="min-w-0 shrink"
              aria-label={t("Workspace")}
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
              onMouseDownCapture={stopContextMenuMouseDown}
            />
          }
        >
          {effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : activeWorktreePath ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <ComposerContextLabel>
            <SelectValue />
          </ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>
          {effectiveEnvMode === "worktree"
            ? resolveEnvModeLabel("worktree")
            : resolveCurrentWorkspaceLabel(activeWorktreePath)}
          {shortcutLabel ? ` · ${shortcutLabel}` : null}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        {...composerFloatingLayerProps}
        className={previousWorktreeLabel ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
      >
        <SelectGroup>
          <SelectGroupLabel>{t("Workspace")}</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              <FolderIcon className="size-3" />
              {resolveEnvModeLabel("local")}
            </span>
          </SelectItem>
          {activeWorktreePath ? (
            <SelectItem value="current-worktree">
              <span className="inline-flex items-center gap-1.5">
                <FolderGitIcon className="size-3" />
                {resolveCurrentWorkspaceLabel(activeWorktreePath)}
              </span>
            </SelectItem>
          ) : null}
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {previousWorktreeLabel ? (
            <SelectItem value="previous-worktree">
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
