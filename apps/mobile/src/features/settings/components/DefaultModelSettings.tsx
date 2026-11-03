import type { MenuAction } from "@react-native-menu/menu";
import { useAtomValue } from "@effect/atom-react";
import type { ServerSettingsPatch } from "@t3tools/contracts";
import { describeModelPick } from "@t3tools/client-runtime/model-traits";
import { modelPicksEqual, withAutoAccount } from "@t3tools/shared/model";
import { autoModePick, resolveAutoModelSelection } from "@t3tools/shared/serverSettings";

import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";
import { buildModelOptions, groupByProvider } from "../../../lib/modelOptions";
import { environmentPresentations } from "../../../state/presentation";
import type { ScopedMobileSettingsTarget } from "../settings-scoped-server";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function DefaultModelSettings(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly disabled: boolean;
  readonly onChange: (patch: ServerSettingsPatch) => void;
}) {
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const selection = props.targets[0]?.settings.defaultModelSelection ?? null;
  const mixed = props.targets.some(({ settings }) =>
    selection === null || settings.defaultModelSelection === null
      ? selection !== settings.defaultModelSelection
      : !modelPicksEqual(selection, settings.defaultModelSelection),
  );
  const optionsByTarget = props.targets.map((target) =>
    buildModelOptions(
      {
        ...target.environment.serverConfig,
        providers: providersByEnvironment.get(target.environment.environmentId) ?? [],
      },
      null,
      undefined,
      target.projectId,
    ).filter((option) => !option.isUnavailable && !option.isLegacy),
  );
  // A shared setting must name a model that exists on every selected environment.
  const options = (optionsByTarget[0] ?? []).filter((option) =>
    optionsByTarget.every((targetOptions) =>
      targetOptions.some(
        (candidate) =>
          candidate.key === option.key && candidate.providerDriver === option.providerDriver,
      ),
    ),
  );
  const accountProviders = props.targets[0]
    ? (providersByEnvironment.get(props.targets[0].environment.environmentId) ?? [])
    : [];
  const accountSettings = props.targets[0]?.settings;
  const autoPick = accountSettings
    ? autoModePick({ settings: accountSettings, accounts: accountProviders, lockedDriver: null })
    : null;
  const autoChecked = selection?.autoAccount === true && autoPick !== null;
  // An Auto default shows the model and account Auto starts threads on.
  const shown =
    selection && accountSettings
      ? resolveAutoModelSelection({
          selection,
          settings: accountSettings,
          accounts: accountProviders,
          started: false,
        })
      : selection;
  const findOption = (target: typeof selection) =>
    options.find(
      (option) =>
        option.selection.instanceId === target?.instanceId &&
        option.selection.model === target.model,
    );
  const selectedOption = findOption(shown);
  const label = mixed
    ? "Mixed"
    : shown === null
      ? "Automatic"
      : selectedOption
        ? autoChecked
          ? `Auto · ${selectedOption.label}`
          : `${selectedOption.providerLabel} · ${selectedOption.label}`
        : shown.model;
  const actions: MenuAction[] = [
    {
      id: "automatic",
      title: "Automatic",
      state: !mixed && selection === null ? "on" : "off",
    },
    ...groupByProvider(options).map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      subactions: group.models.map((option) => ({
        id: `model:${option.key}`,
        title: option.label,
        state: !mixed && option === selectedOption ? ("on" as const) : ("off" as const),
      })),
    })),
  ];
  const row = <ListRowLayout label="Model" detail={label} disabled={props.disabled} />;
  const showAuto =
    !mixed &&
    props.targets.every(
      (target) => target.environment.serverConfig.environment.capabilities.autoMode === true,
    ) &&
    autoPick !== null;
  const autoDetail = autoPick
    ? describeModelPick(
        autoPick,
        accountProviders.find((provider) => provider.instanceId === autoPick.instanceId)?.models ??
          [],
      )
    : null;
  return (
    <SettingsSection
      title="Default model"
      footer={
        props.targets.length > 1 && options.length === 0
          ? "Select one environment to choose from its models. Automatic uses an available provider on each environment."
          : "Automatically use an available provider, or choose a model for new threads and scheduled tasks."
      }
    >
      {props.disabled ? (
        row
      ) : (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Default model: ${label}`}
          title="Default model"
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "automatic") {
              props.onChange({ defaultModelSelection: null });
              return;
            }
            const option = options.find(
              (candidate) => `model:${candidate.key}` === nativeEvent.event,
            );
            if (option) props.onChange({ defaultModelSelection: option.selection });
          }}
        >
          {row}
        </Menu>
      )}
      {showAuto ? (
        <SettingsSwitchRow
          label="Auto"
          subtitle={`Runs ${autoDetail}. Set Auto mode in Settings › Providers on web or desktop.`}
          value={autoChecked}
          disabled={props.disabled}
          onValueChange={(value) => {
            if (value && autoPick) props.onChange({ defaultModelSelection: autoPick });
            else if (!value && shown)
              props.onChange({ defaultModelSelection: withAutoAccount(shown, false) });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
