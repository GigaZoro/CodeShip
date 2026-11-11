import type { ComponentProps } from "react";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";

export function SettingsMenuRow<Value extends string>(props: {
  readonly label: string;
  readonly description?: string;
  readonly icon: ComponentProps<typeof ListRowLayout>["icon"];
  readonly value: string | null;
  readonly currentLabel: string;
  readonly disabled?: boolean;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  const row = (
    <ListRowLayout
      icon={props.icon}
      label={props.label}
      description={[props.currentLabel, props.description].filter(Boolean).join("\n\n")}
      disabled={props.disabled}
    />
  );
  return props.disabled ? (
    row
  ) : (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${props.currentLabel}`}
      title={props.label}
      actions={props.options.map((option) => ({
        id: option.value,
        title: option.label,
        state: option.value === props.value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => {
        const option = props.options.find((candidate) => candidate.value === nativeEvent.event);
        if (option) props.onChange(option.value);
      }}
    >
      {row}
    </Menu>
  );
}
