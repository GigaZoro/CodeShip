import { Pressable } from "react-native";
import type { EnvironmentMachineKind } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { connectionTone } from "../connection/connectionTone";
import { t } from "../../lib/i18n";

export function DraftEnvironmentControl(props: {
  readonly label: string;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly machineKind: EnvironmentMachineKind;
  readonly disabled: boolean;
  readonly onChooseEnvironment: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Choose environment, {label}, {status}", {
        label: props.label,
        status: connectionTone(props.connectionState).label,
      })}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onChooseEnvironment}
      className="h-[44px] flex-row items-center gap-1.5 rounded-xl px-3 active:opacity-65"
      style={props.disabled ? { opacity: 0.45 } : undefined}
    >
      <EnvironmentMachineSymbol
        kind={props.machineKind}
        size={13}
        tintColorClassName="accent-icon-muted"
      />
      <Text className="shrink text-sm text-foreground-muted" numberOfLines={1}>
        {t("on {label}", { label: props.label })}
      </Text>
      <SymbolView name="chevron.right" size={11} tintColorClassName="accent-icon-muted" />
      {props.connectionState !== "connected" ? (
        <ConnectionStatusDot state={props.connectionState} pulse={false} size={6} />
      ) : null}
    </Pressable>
  );
}
