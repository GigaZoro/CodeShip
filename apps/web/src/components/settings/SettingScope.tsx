import { t } from "~/i18n";
import type {
  ExecutionEnvironmentCapabilities,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { useEnvironments } from "../../state/environments";
import {
  SettingsScopeProvider,
  useOptionalSettingsScope,
  useSettingsScope,
} from "./SettingsScopeContext";
import { scopedSettingsAreMixed } from "./scopedSettings";
import { SettingsRow } from "./settingsLayout";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  searchableSetting,
  settingScopeAxesById,
  type SettingScopeAxes,
  type SettingsSearchItemId,
} from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export type ScopedSetting = ReturnType<typeof useSettingsScope> & {
  readonly settings: UnifiedSettings;
  readonly updateSettings: ReturnType<typeof useUpdateScopedSettings>;
  /** Whether this setting's machines hold different values for these keys. */
  readonly mixed: (keys: readonly (keyof ServerSettings)[]) => boolean;
};

function ScopedSettingBody({ children }: { children: (scoped: ScopedSetting) => ReactNode }) {
  const context = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return children({
    ...context,
    settings,
    updateSettings,
    mixed: (keys) => scopedSettingsAreMixed(context.targets, keys),
  });
}

function unitSeed(axes: SettingScopeAxes, parent: SettingsScopeSearch): SettingsScopeSearch {
  if (axes === "project") return parent;
  return parent.machine ? { machine: parent.machine } : {};
}

/**
 * Gives one setting its own machine or project scope and the pill on its row that picks it.
 * Hooks inside read and write that scope; a page that already filters by machine keeps its own.
 */
export function SettingScope({
  setting,
  requires,
  children,
}: {
  setting: SettingsSearchItemId;
  /** Server capabilities every machine in scope needs; the row hides itself where they lack. */
  requires?: readonly SettingCapability[];
  children: ReactNode | ((scoped: ScopedSetting) => ReactNode);
}) {
  const axes = settingScopeAxesById(setting);
  if (axes === null) throw new Error(`Setting ${setting} declares no machine or project scope.`);
  const parent = useOptionalSettingsScope();
  const [search, setSearch] = useState(() => unitSeed(axes, parent?.search ?? {}));
  const body =
    typeof children === "function" ? <ScopedSettingBody>{children}</ScopedSettingBody> : children;
  if (parent?.viewFilter != null) return body;
  return (
    <SettingsScopeProvider
      search={search}
      onChange={setSearch}
      singleEnvironment={axes === "one-machine"}
      unit={{ anchorId: setting, title: searchableSetting(setting).title, axes }}
    >
      {requires ? (
        <SupportedSetting setting={setting} requires={requires}>
          {body}
        </SupportedSetting>
      ) : (
        body
      )}
    </SettingsScopeProvider>
  );
}

type SettingCapability = keyof ExecutionEnvironmentCapabilities;
type ScopeEnvironment = ReturnType<typeof useEnvironments>["environments"][number];

export function supportsCapabilities(
  environment: ScopeEnvironment,
  requires: readonly SettingCapability[],
) {
  const capabilities = environment.serverConfig?.environment.capabilities;
  return (
    environment.connection.phase === "connected" &&
    requires.every((capability) => capabilities?.[capability] === true)
  );
}

/** Where the scope's machines lack a capability another machine has, the pill offers that one. */
function SupportedSetting({
  setting,
  requires,
  children,
}: {
  setting: SettingsSearchItemId;
  requires: readonly SettingCapability[];
  children: ReactNode;
}) {
  const { connectedEnvironments } = useSettingsScope();
  const another = useAnotherMachineMaySupport(requires);
  const supported = (environment: ScopeEnvironment) => supportsCapabilities(environment, requires);
  if (connectedEnvironments.length > 0 && connectedEnvironments.every(supported)) return children;
  // Rows hide themselves when no machine can use them; keep the pill while another machine might.
  return another ? <UnavailableSettingRow setting={setting} /> : children;
}

/** Whether a machine outside the scope may support what the scope's machines can't. */
export function useAnotherMachineMaySupport(requires: readonly SettingCapability[]) {
  const { connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  return connectedEnvironments.length === 0
    ? environments.length > 1
    : environments.some((environment) => supportsCapabilities(environment, requires));
}

/** Stands in for a setting the scoped machines can't use, so its pill can pick one that can. */
export function UnavailableSettingRow({ setting }: { setting: SettingsSearchItemId }) {
  const { scope } = useSettingsScope();
  return (
    <SettingsRow
      {...searchableSetting(setting)}
      description={t("Not available on {scope}. Choose a machine that supports it.", {
        scope: scope.label,
      })}
    />
  );
}
