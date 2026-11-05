import { msg, t } from "../../../lib/i18n";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomValue } from "@effect/atom-react";
import type { ModelSelection, ServerSettingsPatch } from "@t3tools/contracts";
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

const MODEL_SETTINGS = {
  defaultModelSelection: {
    title: msg("Default model"),
    unsetLabel: msg("Automatic"),
    footer: msg(
      "Automatically use an available provider, or choose a model for new threads and new scheduled tasks.",
    ),
  },
  scheduledTaskModelSelection: {
    title: msg("Scheduled tasks model"),
    unsetLabel: msg("Same as new threads"),
    footer: msg(
      "Runs scheduled tasks that use the default model. Same as new threads follows the default model above.",
    ),
  },
} as const;

export function DefaultModelSettings(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  /** Default: the new-thread model. */
  readonly setting?: keyof typeof MODEL_SETTINGS;
  readonly disabled: boolean;
  /** Absent where a project is selected or a server cannot store the setting. */
  readonly lastPicked?: { readonly value: boolean | null; readonly disabled: boolean };
  readonly onChange: (patch: ServerSettingsPatch) => void;
}) {
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const key = props.setting ?? "defaultModelSelection";
  const copy = MODEL_SETTINGS[key];
  const write = (value: ModelSelection | null) =>
    props.onChange(
      key === "defaultModelSelection"
        ? { defaultModelSelection: value }
        : { scheduledTaskModelSelection: value },
    );
  const selection = props.targets[0]?.settings[key] ?? null;
  const mixed = props.targets.some(({ settings }) =>
    selection === null || settings[key] === null
      ? selection !== settings[key]
      : !modelPicksEqual(selection, settings[key]),
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
    ? t("Mixed")
    : shown === null
      ? t(copy.unsetLabel)
      : selectedOption
        ? autoChecked
          ? t("Auto · {model}", { model: selectedOption.label })
          : t("{provider} · {model}", {
              provider: selectedOption.providerLabel,
              model: selectedOption.label,
            })
        : shown.model;
  const actions: MenuAction[] = [
    {
      id: "automatic",
      title: t(copy.unsetLabel),
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
  const row = <ListRowLayout label={t("Model")} detail={label} disabled={props.disabled} />;
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
      title={t(copy.title)}
      footer={
        props.targets.length > 1 && options.length === 0
          ? t(
              "Select one environment to choose from its models. {unsetLabel} applies on each environment.",
              { unsetLabel: t(copy.unsetLabel) },
            )
          : t(copy.footer)
      }
    >
      {props.disabled ? (
        row
      ) : (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={t("{title}: {value}", { title: t(copy.title), value: label })}
          title={t(copy.title)}
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "automatic") {
              write(null);
              return;
            }
            const option = options.find(
              (candidate) => `model:${candidate.key}` === nativeEvent.event,
            );
            if (option) write(option.selection);
          }}
        >
          {row}
        </Menu>
      )}
      {showAuto ? (
        <SettingsSwitchRow
          label={t("Auto")}
          subtitle={t("Runs {model}. Set Auto mode in Settings › Providers on web or desktop.", {
            model: autoDetail ?? "",
          })}
          value={autoChecked}
          disabled={props.disabled}
          onValueChange={(value) => {
            if (value && autoPick) write(autoPick);
            else if (!value && shown) write(withAutoAccount(shown, false));
          }}
        />
      ) : null}
      {props.lastPicked ? (
        <SettingsSwitchRow
          label={t("Use last picked model")}
          subtitle={t(
            "New threads start on the model you last picked on this device, Auto included. Until you pick one, they use the model above. Scheduled tasks are not affected.",
          )}
          value={props.lastPicked.value}
          disabled={props.lastPicked.disabled}
          onValueChange={(value) => props.onChange({ newThreadsUseLastModel: value })}
        />
      ) : null}
    </SettingsSection>
  );
}
