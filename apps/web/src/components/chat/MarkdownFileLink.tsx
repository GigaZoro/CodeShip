import { t } from "~/i18n";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { MouseEvent as ReactMouseEvent } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { shouldOpenMarkdownFileLinkInEditor } from "../../markdown-links";
import type { markdownFileCopyPaths } from "../../markdownFileHostPath";
import { documentChipKindForFileName } from "../../pierre-icons";
import { ContextChip } from "../ContextChip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FileTagChipContent } from "./FileTagChip";
import {
  hasMarkdownFilePrimaryAction,
  markdownFileCopyMenuItems,
  shouldUseMarkdownFileBrowserPrimaryAction,
} from "./MarkdownFileLink.logic";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { WorkspaceEntryTooltip } from "./WorkspaceEntryIcon";

interface MarkdownFileLinkProps {
  environmentId: EnvironmentId | null;
  href: string;
  targetPath: string;
  iconPath: string;
  workspaceRelativePath: string | null;
  panelPath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenInPanel: (panelPath: string, line: number | undefined) => void;
  resolveCopyPaths: () => Promise<ReturnType<typeof markdownFileCopyPaths>>;
  openInEditorMenuLabel: string;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  onOpenMedia?: (() => void) | undefined;
  onReveal?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  revealLabel?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME = "chat-markdown-file-link";

export function MarkdownFileLink({
  environmentId,
  href,
  targetPath,
  iconPath,
  workspaceRelativePath,
  panelPath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onOpenInPanel,
  openInEditorMenuLabel,
  onOpenInBrowser,
  onOpenMedia,
  onReveal,
  revealLabel,
  resolveCopyPaths,
}: MarkdownFileLinkProps) {
  const handleOpenInEditor = () => {
    if (!onOpen) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpen();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file"),
            description: cause instanceof Error ? cause.message : t("An error occurred."),
          }),
        );
      }
    })();
  };

  const handleOpenInFilePreview = () => {
    if (threadRef && panelPath) {
      onOpenInPanel(panelPath, line);
      return;
    }
    if (onOpenMedia) {
      onOpenMedia();
      return;
    }
    handleOpenInEditor();
  };

  const handleOpenInBrowser = () => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file in browser"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to open file in browser"),
            description: cause instanceof Error ? cause.message : t("An error occurred."),
          }),
        );
      }
    })();
  };

  const handleRevealInFileManager = () => {
    if (!onReveal) {
      return;
    }
    void (async () => {
      try {
        const result = await onReveal();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to reveal file"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "reveal-file-in-file-manager", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Unable to reveal file"),
            description: cause instanceof Error ? cause.message : t("An error occurred."),
          }),
        );
      }
    })();
  };

  const handleCopy = (resolveValue: () => Promise<string>, kind: "relative" | "full") => {
    // oxlint-disable-next-line t3code/no-untranslated-text -- failure-report log field, not shown
    const title = kind === "relative" ? "Relative path" : "Full path";
    const failedTitle =
      kind === "relative" ? t("Failed to copy relative path") : t("Failed to copy full path");
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failedTitle,
          description: t("Clipboard API unavailable."),
        }),
      );
      return;
    }

    const value = resolveValue().then((text) => formatFilePathForClipboard(text, targetPath));
    // Start the write before workspace lookup finishes so Safari retains the user gesture.
    const write =
      typeof navigator.clipboard.write === "function" && typeof ClipboardItem !== "undefined"
        ? navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })),
            }),
          ])
        : value.then((text) => navigator.clipboard.writeText(text));
    void Promise.all([write, value]).then(
      ([, text]) => {
        toastManager.add({
          type: "success",
          title: kind === "relative" ? t("Relative path copied") : t("Full path copied"),
          description: text,
        });
      },
      (error) => {
        reportMarkdownActionFailure(
          { operation: "copy-file-path", target: targetPath, copyTarget: title },
          error,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failedTitle,
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      },
    );
  };

  const showFileContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;

    try {
      const copyItems = markdownFileCopyMenuItems({ targetPath, workspaceRelativePath });
      const clicked = await api.contextMenu.show(
        [
          ...(onOpenMedia ? ([{ id: "preview-media", label: t("Preview media") }] as const) : []),
          ...(onOpen ? ([{ id: "open", label: openInEditorMenuLabel }] as const) : []),
          ...(onOpenInBrowser
            ? ([{ id: "open-in-browser", label: t("Open in integrated browser") }] as const)
            : []),
          ...(onReveal && revealLabel ? ([{ id: "reveal", label: revealLabel }] as const) : []),
          ...copyItems.map(({ id, label }) => ({ id, label })),
        ] as const,
        position,
      );

      if (clicked === "preview-media") {
        onOpenMedia?.();
        return;
      }
      if (clicked === "open") {
        handleOpenInEditor();
        return;
      }
      if (clicked === "open-in-browser") {
        handleOpenInBrowser();
        return;
      }
      if (clicked === "reveal") {
        handleRevealInFileManager();
        return;
      }
      if (clicked === "copy-relative" || clicked === "copy-full") {
        handleCopy(
          () =>
            resolveCopyPaths().then((paths) =>
              clicked === "copy-relative" ? paths.relativePath : paths.fullPath,
            ),
          clicked === "copy-relative" ? "relative" : "full",
        );
      }
    } catch (cause) {
      reportMarkdownActionFailure(
        { operation: "show-file-context-menu", target: targetPath },
        cause,
      );
    }
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const position =
      event.clientX === 0 && event.clientY === 0
        ? (() => {
            const bounds = event.currentTarget.getBoundingClientRect();
            return { x: bounds.left, y: bounds.bottom };
          })()
        : { x: event.clientX, y: event.clientY };
    void showFileContextMenu(position);
  };

  const canOpenInEditor = onOpen !== undefined;
  const canOpenInBrowser = onOpenInBrowser !== undefined;
  const canOpenInPanel = threadRef !== undefined && Boolean(panelPath);
  const hasPrimaryAction = hasMarkdownFilePrimaryAction({
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
    canOpenMedia: onOpenMedia !== undefined,
  });
  const useBrowserPrimaryAction = shouldUseMarkdownFileBrowserPrimaryAction({
    iconPath,
    canOpenInEditor,
    canOpenInBrowser,
    canOpenInPanel,
  });
  const chipKind = documentChipKindForFileName(iconPath) ?? "mention";
  const handlePrimaryClick = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (onOpen && shouldOpenMarkdownFileLinkInEditor(event)) {
      handleOpenInEditor();
      return;
    }
    if (useBrowserPrimaryAction) {
      handleOpenInBrowser();
      return;
    }
    handleOpenInFilePreview();
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          hasPrimaryAction ? (
            <ContextChip
              kind={chipKind}
              dir="ltr"
              render={<a href={href} />}
              className={MARKDOWN_FILE_LINK_CLASS_NAME}
              data-markdown-copy={copyMarkdown}
              onClick={handlePrimaryClick}
              // A middle click would open the path as a page of this app in a new tab.
              onAuxClick={(event) => {
                if (event.button === 1) handlePrimaryClick(event);
              }}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent
                path={iconPath}
                environmentId={environmentId}
                label={label}
                theme={theme}
              />
            </ContextChip>
          ) : (
            <ContextChip
              kind={chipKind}
              dir="ltr"
              render={<button type="button" />}
              aria-label={t("File options for {label}", { label })}
              aria-haspopup="menu"
              className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, "select-text")}
              data-markdown-copy={copyMarkdown}
              onClick={handleContextMenu}
              onContextMenu={handleContextMenu}
            >
              <FileTagChipContent
                path={iconPath}
                environmentId={environmentId}
                label={label}
                theme={theme}
              />
            </ContextChip>
          )
        }
      />
      <TooltipPopup side="top" variant="code">
        <div className="overflow-x-auto whitespace-nowrap scrollbar-thumb-border/78 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/78 [&::-webkit-scrollbar-track]:bg-transparent">
          <WorkspaceEntryTooltip path={iconPath} label={targetPath} environmentId={environmentId} />
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
