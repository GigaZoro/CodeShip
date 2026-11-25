import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { ACCENT_COLOR_HUES, AccentColor } from "@t3tools/contracts/settings";
import { ACCENT_PALETTE } from "@t3tools/shared/accentPalette";
import * as Schema from "effect/Schema";
import { CheckIcon, PaletteIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { msg, t, type Message } from "~/i18n";
import { cn } from "~/lib/utils";

const ACCENT_COLOR_LABELS: Record<AccentColor, Message> = {
  theme: msg("Theme"),
  blue: msg("Blue"),
  indigo: msg("Indigo"),
  violet: msg("Violet"),
  pink: msg("Pink"),
  red: msg("Red"),
  orange: msg("Orange"),
  green: msg("Green"),
  teal: msg("Teal"),
};

const isAccentColor = Schema.is(AccentColor);

const SWATCH_CLASS_NAME =
  "relative inline-flex size-[max(24px,1.75rem)] shrink-0 cursor-pointer items-center justify-center rounded-full border border-border outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-checked:border-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-background";

/** Raw radios on purpose: a swatch's geometry and fill are its own, which no `ui` primitive offers. */
export function AccentColorPicker(props: {
  readonly value: AccentColor;
  readonly onValueChange: (value: AccentColor) => void;
}) {
  return (
    <RadioGroup
      aria-label={t("Accent color")}
      className="flex flex-wrap items-center gap-2"
      value={props.value}
      onValueChange={(value) => {
        if (isAccentColor(value)) props.onValueChange(value);
      }}
    >
      <Radio.Root
        value="theme"
        aria-label={t(ACCENT_COLOR_LABELS.theme)}
        title={t(ACCENT_COLOR_LABELS.theme)}
        className={cn(SWATCH_CLASS_NAME, "bg-muted text-muted-foreground")}
      >
        <PaletteIcon aria-hidden className="size-3.5" />
      </Radio.Root>
      {ACCENT_COLOR_HUES.map((hue) => (
        <Radio.Root
          key={hue}
          value={hue}
          aria-label={t(ACCENT_COLOR_LABELS[hue])}
          title={t(ACCENT_COLOR_LABELS[hue])}
          className={cn(SWATCH_CLASS_NAME, "bg-(--swatch-light) dark:bg-(--swatch-dark)")}
          style={
            {
              "--swatch-light": ACCENT_PALETTE[hue].light.primary,
              "--swatch-dark": ACCENT_PALETTE[hue].dark.primary,
            } as CSSProperties
          }
        >
          <Radio.Indicator keepMounted={false}>
            <CheckIcon aria-hidden className="size-4 text-white" />
          </Radio.Indicator>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
