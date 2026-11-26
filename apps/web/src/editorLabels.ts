import { msg, t } from "~/i18n";
import { EDITORS, type EditorId } from "@t3tools/contracts";

import { getLocalFileManagerName } from "~/lib/utils";

const editorLabels = new Map<EditorId, string>(EDITORS.map((editor) => [editor.id, editor.label]));

export function editorLabelForPlatform(
  editorId: EditorId,
  platform: string,
  resolve: typeof t = t,
): string {
  if (editorId === "file-manager") {
    return getLocalFileManagerName(platform, resolve);
  }

  return editorLabels.get(editorId) ?? resolve(msg("Editor"));
}

export function openInEditorMenuLabel(editorId: EditorId | null, resolve: typeof t = t): string {
  return editorId === null || editorId === "file-manager"
    ? resolve(msg("Open in editor"))
    : resolve(msg("Open in {editor}"), {
        editor: editorLabels.get(editorId) ?? resolve(msg("Editor")),
      });
}
