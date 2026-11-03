import { Switch } from "../ui/switch";

export function AutoModeControl(props: {
  readonly modelLabel: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 border-t px-3 py-2">
      <span className="min-w-0 text-xs leading-snug">
        <span className="block text-foreground">Auto</span>
        <span className="block truncate text-muted-foreground">{props.modelLabel}</span>
      </span>
      <Switch
        size="sm"
        aria-label={`Auto: ${props.modelLabel}`}
        checked={props.checked}
        onCheckedChange={props.onCheckedChange}
      />
    </label>
  );
}
