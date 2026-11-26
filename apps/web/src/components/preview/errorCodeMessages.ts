import { msg, t } from "~/i18n";

import { PREVIEW_ERROR_CODE_MESSAGES } from "./previewConstants";

export function describePreviewError(description: string, resolve: typeof t = t): string {
  const friendly = PREVIEW_ERROR_CODE_MESSAGES[description];
  if (friendly) return resolve(friendly);
  if (description.length > 0) return description;
  return resolve(msg("Network error"));
}
