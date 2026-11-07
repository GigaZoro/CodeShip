import { createContext, use, type ReactNode } from "react";

import { t } from "~/i18n";

import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface DiffFileViewedState {
  readonly isViewed: (path: string) => boolean;
  /** Marked viewed, but the file changed since. */
  readonly isStale: (path: string) => boolean;
  readonly staleDescription: string;
  readonly setFileViewed: (fileKey: string, viewed: boolean, extendRange: boolean) => void;
}

// Context updates viewed toggles without invalidating memoized header portals.
export const DiffFileViewedContext = createContext<DiffFileViewedState | null>(null);

/** Header click handlers that fold a file skip `[data-viewed-toggle]`, or its label folds twice. */
export function DiffFileViewedToggle({
  fileKey,
  path,
  stat,
}: {
  readonly fileKey: string;
  readonly path: string;
  readonly stat: ReactNode;
}) {
  const viewedFiles = use(DiffFileViewedContext);
  if (viewedFiles === null) return stat;
  const viewed = viewedFiles.isViewed(path);
  const stale = viewedFiles.isStale(path);
  return (
    <span className="flex items-center gap-3">
      {stat}
      <label
        data-viewed-toggle=""
        className="flex w-18 shrink-0 cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={stale ? t("Changed") : t("Viewed")}
          checked={viewed}
          onCheckedChange={(next, details) =>
            viewedFiles.setFileViewed(
              fileKey,
              next === true,
              "shiftKey" in details.event && details.event.shiftKey === true,
            )
          }
        />
        {stale ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              {t("Changed")}
            </TooltipTrigger>
            <TooltipPopup side="bottom">{viewedFiles.staleDescription}</TooltipPopup>
          </Tooltip>
        ) : (
          <span className="@max-xs:hidden">{t("Viewed")}</span>
        )}
      </label>
    </span>
  );
}
