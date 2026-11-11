import type { ReactNode } from "react";

import { SettingsSearchTarget } from "./settingsLayout";

/** One choice inside a model role's row, such as a fallback model or one delegated role. */
export function ModelSubRow({
  id,
  title,
  description,
  reset,
  control,
  children,
}: {
  readonly id?: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly reset?: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSearchTarget
      {...(id !== undefined ? { id } : {})}
      className="mt-3 border-t border-border/50 py-3"
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h4 className="text-sm font-medium text-foreground">{title}</h4>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {reset}
            </span>
          </div>
          {description ? (
            <p className="max-w-2xl text-balance text-xs leading-normal text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </SettingsSearchTarget>
  );
}
