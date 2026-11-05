import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";
import { t } from "~/i18n";

export function describePreviewError(description: string): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return t(friendly);
  if (description.length > 0) return description;
  return t("Network error");
}
