import { Switch } from "../ui/switch";

export function AutoAccountControl(props: {
  readonly providerName: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 border-t px-3 py-2">
      <span className="min-w-0 text-xs leading-snug">
        <span className="block text-foreground">Auto account</span>
        <span className="block text-muted-foreground">
          First {props.providerName} account in your account order with usage left
        </span>
      </span>
      <Switch size="sm" checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </label>
  );
}
