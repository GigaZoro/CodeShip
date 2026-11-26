import { t } from "~/i18n";
import type { EnvironmentId } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";

import type { MarkdownFileLinkMeta } from "../../markdown-links";
import type { RemoteOpenMode } from "../../remoteOpen";

export function canUseMarkdownFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

// Diagnostic names stay stable across UI languages.
export const FILE_PATH_COPY_TARGET = { relative: "Relative path", full: "Full path" };

export function markdownFileCopyMenuItems({
  targetPath,
  workspaceRelativePath,
}: Pick<MarkdownFileLinkMeta, "targetPath" | "workspaceRelativePath">) {
  const items = [
    {
      id: "copy-full",
      label: t("Copy full path"),
      value: targetPath,
      title: FILE_PATH_COPY_TARGET.full,
    },
  ];
  if (workspaceRelativePath !== null) {
    const position = targetPath.slice(splitFilePathPosition(targetPath).path.length);
    items.unshift({
      id: "copy-relative",
      label: t("Copy relative path"),
      value: `${workspaceRelativePath}${position}`,
      title: FILE_PATH_COPY_TARGET.relative,
    });
  }
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return input.canOpenInBrowser && !input.canOpenInEditor && !input.canOpenInPanel;
}
