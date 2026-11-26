import { t } from "~/i18n";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

import { changeRequestTermKind } from "./changeRequestTerm";

export function offHeadPullRequestCheckoutToast(terminology: ChangeRequestTerminology) {
  return {
    type: "warning",
    title: t("Checked out, but not confirmed on the latest commit"),
    description:
      changeRequestTermKind(terminology) === "mr"
        ? t(
            "This checkout could not be confirmed at the merge request's latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
          )
        : changeRequestTermKind(terminology) === "cr"
          ? t(
              "This checkout could not be confirmed at the change request's latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
            )
          : t(
              "This checkout could not be confirmed at the pull request's latest commit, so its code may differ. Local commits or uncommitted work keep a checkout where it is.",
            ),
  } as const;
}
