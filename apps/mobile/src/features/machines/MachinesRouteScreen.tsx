import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { machineAvailability, machineAvailabilityLabel } from "@t3tools/client-runtime/connection";
import {
  describeCpu,
  describeFreeSpace,
  describeUptime,
  describeUsedSpace,
  presentHostResources,
  resourceTone,
  type HostResourcesView,
  type ResourceMeter,
  type ResourceTone,
} from "@t3tools/client-runtime/host-resources";
import { formatTimeAgo } from "@t3tools/client-runtime/scheduled-task-pins";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { formatPercent } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { environmentCatalog } from "../../connection/catalog";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { t } from "../../lib/i18n";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";

const MAX_CONTENT_WIDTH = 720;

const BAR_FILL_CLASS: Record<ResourceTone, string> = {
  default: "bg-primary",
  warning: "bg-warning-foreground",
  error: "bg-danger-foreground",
};

function subscribeAppState(onChange: () => void) {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
}

/** The native stack keeps this screen mounted under pushed ones and while the app is in the background. */
function useScreenVisible() {
  const focused = useIsFocused();
  const appState = useSyncExternalStore(subscribeAppState, () => AppState.currentState);
  return focused && appState !== "background";
}

export function MachinesRouteScreen(props: { readonly workspace?: boolean }) {
  const insets = useSafeAreaInsets();
  const environments = useWorkspaceEnvironments();
  const visible = useScreenVisible();
  return (
    <SettingsScreen title={t("Machines")} workspaceRoot={props.workspace}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="w-full gap-4 self-center" style={{ maxWidth: MAX_CONTENT_WIDTH }}>
          {environments.length === 0 ? (
            <Text className="py-16 text-center text-base text-foreground-muted">
              {t("Connect an environment to see machines.")}
            </Text>
          ) : (
            environments.map((environment) => (
              <MachineCard
                key={environment.environmentId}
                environment={environment}
                visible={visible}
              />
            ))
          )}
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function MachineCard(props: {
  readonly environment: EnvironmentConnectionSummary;
  readonly visible: boolean;
}) {
  const { environment } = props;
  const presentation = useAtomValue(
    environmentPresentations.presentationAtom(environment.environmentId),
  );
  const retry = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const setEnabled = useAtomCommand(environmentCatalog.setEnabled, "environment toggle");
  const live = environment.isEnabled && environment.connectionState === "connected";
  const stateLabel = environment.isEnabled
    ? machineAvailabilityLabel(machineAvailability(environment.connectionState))
    : t("Off");
  return (
    <View className="gap-4 rounded-[24px] border-continuous bg-grouped-card p-4">
      <View className="flex-row items-center gap-3">
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(presentation?.serverConfig ?? null)}
          size={22}
          tintColorClassName="accent-foreground-muted"
        />
        <View className="min-w-0 flex-1">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {environment.environmentLabel}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {stateLabel}
            {live || environment.lastSeenAt === null ? null : (
              <MachineLastSeen lastSeenAt={environment.lastSeenAt} />
            )}
          </Text>
        </View>
      </View>
      {live && props.visible ? (
        <MachineResources environmentId={environment.environmentId} />
      ) : null}
      {live ? null : (
        <Button
          label={environment.isEnabled ? t("Reconnect") : t("Switch on")}
          onPress={() => {
            void (environment.isEnabled
              ? retry(environment.environmentId)
              : setEnabled({ environmentId: environment.environmentId, enabled: true }));
          }}
        />
      )}
    </View>
  );
}

function MachineLastSeen(props: { readonly lastSeenAt: number }) {
  const nowMs = useNowMinuteMs();
  const time = formatTimeAgo(new Date(props.lastSeenAt).toISOString(), nowMs);
  return ` · ${t("last seen {time}", { time })}`;
}

// Mounted only while the machine is connected and the screen is on view, so the 5 s poll runs only then.
function MachineResources(props: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(
    serverEnvironment.liveHostResources({ environmentId: props.environmentId, input: {} }),
  );
  if (AsyncResult.isSuccess(result)) {
    return <ResourceRows view={presentHostResources(result.value)} />;
  }
  if (AsyncResult.isFailure(result)) {
    return (
      <Text className="text-sm text-foreground-muted">
        {t("Couldn't read this machine's resources.")}
      </Text>
    );
  }
  return <AppActivityIndicator />;
}

function ResourceRows(props: { readonly view: HostResourcesView }) {
  const { view } = props;
  const cpuTone = resourceTone(view.cpuFraction);
  return (
    <View className="gap-4">
      <ResourceRow
        label={t("CPU")}
        value={view.cpuFraction === null ? null : formatPercent(view.cpuFraction, 0)}
        fraction={view.cpuFraction}
        tone={cpuTone}
        detail={describeCpu(view)}
      />
      {view.memory ? (
        <MeterRow label={t("Memory")} meter={view.memory} detail={describeUsedSpace(view.memory)} />
      ) : null}
      {view.swap ? (
        view.swap.totalBytes === 0 ? (
          <ResourceRow label={t("Swap")} value={null} fraction={null} detail={t("None in use")} />
        ) : (
          <MeterRow label={t("Swap")} meter={view.swap} detail={describeUsedSpace(view.swap)} />
        )
      ) : null}
      {view.disk ? (
        <MeterRow label={t("Disk")} meter={view.disk} detail={describeFreeSpace(view.disk)} />
      ) : null}
      {view.uptimeSeconds === null ? null : (
        <Text className="text-xs text-foreground-tertiary">
          {describeUptime(view.uptimeSeconds)}
        </Text>
      )}
    </View>
  );
}

function MeterRow(props: {
  readonly label: string;
  readonly meter: ResourceMeter;
  readonly detail: string;
}) {
  return (
    <ResourceRow
      label={props.label}
      value={formatPercent(props.meter.fraction, 0)}
      fraction={props.meter.fraction}
      tone={resourceTone(props.meter.fraction)}
      detail={props.detail}
    />
  );
}

function ResourceRow(props: {
  readonly label: string;
  readonly value: string | null;
  readonly fraction: number | null;
  readonly tone?: ResourceTone;
  readonly detail: string;
}) {
  const fraction = props.fraction === null ? null : Math.max(0, Math.min(1, props.fraction));
  return (
    <View className="gap-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
        {props.value === null ? null : (
          <Text className="text-sm tabular-nums text-foreground">{props.value}</Text>
        )}
      </View>
      {fraction === null ? null : (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={props.label}
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
          className="h-1.5 overflow-hidden rounded-full bg-subtle"
        >
          <View
            className={cn("h-full rounded-full", BAR_FILL_CLASS[props.tone ?? "default"])}
            style={{ width: `${fraction * 100}%` }}
          />
        </View>
      )}
      <Text className="text-xs text-foreground-muted">{props.detail}</Text>
    </View>
  );
}
