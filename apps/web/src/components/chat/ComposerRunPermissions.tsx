import type { RuntimeMode } from "@t3tools/contracts";
import { type KeyboardEvent, useId, useState } from "react";

import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import type { RuntimeModeOption } from "./ComposerFooterControls";
import { runtimeModeConfig } from "./runtimeModeConfig";

/**
 * Permission modes as one horizontal radio group, with the shown mode named below. Lives in the
 * run chip's popover beside model and effort, so it is a plain radio group, not a menu.
 */
export function ComposerRunPermissions(props: {
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  // Hover or keyboard focus previews a mode's name and description before a pick.
  const [previewMode, setPreviewMode] = useState<RuntimeMode | null>(null);
  const shownMode = previewMode ?? props.runtimeMode;
  const shown: RuntimeModeOption = props.runtimeModeOptions.find(
    (option) => option.mode === shownMode,
  ) ?? { mode: shownMode, ...runtimeModeConfig[shownMode] };
  const labelId = useId();
  const descriptionId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // Start from the focused mode: the checked one can be blocked by policy and skipped below.
    const options = props.runtimeModeOptions;
    const focusedMode = (event.target as HTMLElement).dataset.runtimeMode;
    const start = options.findIndex((option) => option.mode === (focusedMode ?? props.runtimeMode));
    for (let offset = 1; offset <= options.length; offset += 1) {
      const next =
        options[(((start + step * offset) % options.length) + options.length) % options.length];
      if (!next || next.disabledReason !== undefined) continue;
      props.onRuntimeModeChange(next.mode);
      event.currentTarget
        .querySelector<HTMLElement>(`[data-runtime-mode="${next.mode}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
  };

  return (
    <div
      data-composer-permissions
      className="grid w-full gap-1.5 border-t border-border/70 bg-muted/40 px-3 py-2"
    >
      <div id={labelId} className="font-medium text-muted-foreground text-xs">
        {t("Permissions")}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="flex rounded-lg bg-input/40 p-0.5"
      >
        {props.runtimeModeOptions.map((option) => {
          const OptionIcon = option.icon;
          const checked = option.mode === props.runtimeMode;
          const blocked = option.disabledReason !== undefined;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={t(option.label)}
              aria-describedby={`${descriptionId}-${option.mode}`}
              data-runtime-mode={option.mode}
              // Not `disabled`: a blocked mode still takes hover and focus to show its reason.
              aria-disabled={blocked || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => {
                if (!checked && !blocked) props.onRuntimeModeChange(option.mode);
              }}
              onPointerEnter={() => setPreviewMode(option.mode)}
              onPointerLeave={() => setPreviewMode(null)}
              onFocus={() => setPreviewMode(option.mode)}
              onBlur={() => setPreviewMode(null)}
              className={cn(
                "flex h-6 flex-1 cursor-pointer items-center justify-center text-muted-foreground outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-disabled:cursor-not-allowed aria-disabled:opacity-40",
                checked ? "bg-input/72 text-foreground" : "hover:bg-accent",
              )}
            >
              <OptionIcon aria-hidden="true" className="size-3.5" />
            </button>
          );
        })}
      </div>
      {/* Static per-mode descriptions for screen readers; the preview below is visual only. */}
      {props.runtimeModeOptions.map((option) => (
        <span key={option.mode} id={`${descriptionId}-${option.mode}`} className="sr-only">
          {option.disabledReason ?? t(option.description)}
        </span>
      ))}
      <div className="grid gap-0.5" aria-hidden="true">
        <span
          className={
            shownMode === props.runtimeMode
              ? "text-foreground text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {t(shown.label)}
        </span>
        {/* Two lines reserved so the popover does not shift while you preview modes. */}
        <span className="min-h-8 text-muted-foreground text-xs leading-4">
          {shown.disabledReason ?? t(shown.description)}
        </span>
      </div>
    </div>
  );
}
