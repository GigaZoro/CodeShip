import { useState } from "react";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { normalizeIntervalSeconds } from "./SettingsPanels.logic";
import { t } from "~/i18n";

/** A settings number that saves when committed and returns to the saved value if the save fails. */
export function CommittedNumberField({
  label,
  inputLabel,
  value,
  min,
  max,
  step,
  normalize,
  onCommit,
}: {
  label: string;
  inputLabel: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  normalize: (value: number) => number;
  onCommit: (value: number, options: { onFailed: () => void }) => void;
}) {
  const [field, setField] = useState({
    saved: value,
    draft: value as number | null,
    committed: value,
    revision: 0,
  });
  if (field.saved !== value) {
    setField({ ...field, saved: value, draft: value, committed: value });
  }

  return (
    <NumberField
      value={field.draft}
      min={min}
      {...(max === undefined ? {} : { max })}
      step={step}
      size="sm"
      className="w-32"
      onValueChange={(draft) => setField((current) => ({ ...current, draft }))}
      onValueCommitted={(next) => {
        if (next === null) {
          setField((current) => ({ ...current, draft: current.saved }));
          return;
        }
        const normalized = normalize(next);
        if (normalized === field.committed) {
          setField((current) => ({ ...current, draft: normalized }));
          return;
        }
        const revision = field.revision + 1;
        setField((current) => ({
          ...current,
          draft: normalized,
          committed: normalized,
          revision,
        }));
        onCommit(normalized, {
          onFailed: () =>
            setField((current) =>
              current.revision !== revision
                ? current
                : {
                    ...current,
                    committed: current.saved,
                    draft: current.draft === normalized ? current.saved : current.draft,
                  },
            ),
        });
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={t("Decrease {label}", { label })} />
        <NumberFieldInput aria-label={inputLabel} />
        <NumberFieldIncrement aria-label={t("Increase {label}", { label })} />
      </NumberFieldGroup>
    </NumberField>
  );
}

export function IntervalSecondsField({
  label,
  value,
  min,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onCommit: (seconds: number, options: { onFailed: () => void }) => void;
}) {
  return (
    <CommittedNumberField
      label={label}
      inputLabel={t("{label} in seconds", {
        label: `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
      })}
      value={value}
      min={min}
      step={step}
      normalize={(seconds) => normalizeIntervalSeconds(seconds, min)}
      onCommit={onCommit}
    />
  );
}
