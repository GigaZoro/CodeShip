import { t } from "~/i18n";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  requiredScopesForServerSettingsPatch,
  EnvironmentAuthorizationError,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { hasSharedSettingsGroup } from "@t3tools/client-runtime/state/shared-settings";

import { persistClientSettingsPatch, useMergedSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  sharedSaveSummary,
  type ProjectOverrideEntry,
  type SavedScopedServerWrite,
  type ScopedSettingsPatch,
  type ScopedSettingsPlan,
} from "./scopedSettings";

export function useScopedSettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const { target } = useSettingsScope();
  return useMergedSettings(target?.settings ?? DEFAULT_SERVER_SETTINGS, selector);
}

export function useScopedSettingsMixed(keys: readonly (keyof ServerSettings)[]): boolean {
  const { targets } = useSettingsScope();
  return scopedSettingsAreMixed(targets, keys);
}

export function useScopedSettingSource(keys: readonly (keyof ServerSettings)[]) {
  const { targets } = useSettingsScope();
  return scopedSettingsSource(targets, keys);
}

export interface ScopedSettingsWriteOptions {
  /** Runs when any target rejects or drops the patch, so a draft can fall back. */
  readonly onFailed?: () => void;
  /** Runs with each target that saved the patch and the settings it now has. */
  readonly onSaved?: (saved: ReadonlyArray<SavedScopedServerWrite>) => void;
}

/** Refuses a write this connection lacks the grants for before it reaches the server. */
function missingSettingsGrant(request: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly patch: ServerSettingsPatch };
}) {
  const missing = requiredScopesForServerSettingsPatch(request.input.patch).find(
    (scope) => !readEnvironmentScope(request.environmentId, scope),
  );
  return missing === undefined
    ? undefined
    : AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: missing,
            message: t("This connection lacks permission to change these settings."),
          }),
        ),
      );
}

export function useRunScopedSettingsPlan() {
  const updateServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const shareServer = useAtomCommand(serverEnvironment.shareSettings, { reportFailure: false });
  return (plan: ScopedSettingsPlan, options?: ScopedSettingsWriteOptions) => {
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: t("Setting not saved"),
        description: plan.unavailableReason,
      });
      options?.onFailed?.();
      return;
    }
    void persistScopedSettingsPatch(
      plan,
      {
        update: async (request) => missingSettingsGrant(request) ?? updateServer(request),
        share: async (request) => missingSettingsGrant(request) ?? shareServer(request),
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      if (savedEnvironmentCount > 0) options?.onSaved?.(savedEnvironments);
      if (failedEnvironments.length === 0) {
        const shared = plan.share === null ? null : sharedSaveSummary(savedEnvironments, plan);
        if (shared !== null) {
          toastManager.add({
            type: "success",
            title: t("Saved for all machines"),
            description: [
              t("Saved on {environments}.", { environments: shared.reached.join(", ") }),
              ...(shared.catchingUp.length > 0
                ? [
                    t(
                      "Offline machines that follow shared settings will take it when they are back: {machines}.",
                      { machines: shared.catchingUp.join(", ") },
                    ),
                  ]
                : []),
            ].join("\n"),
          });
        }
        return;
      }
      options?.onFailed?.();
      toastManager.add({
        type: "error",
        title:
          savedEnvironmentCount > 0
            ? t("Setting saved on some environments")
            : t("Setting not saved"),
        description: [
          ...failedEnvironments.map(({ label, message }) =>
            t("Could not save on {label}: {message}", { label, message }),
          ),
          ...(savedEnvironmentCount > 0
            ? [
                t("Saved on {environments}.", {
                  environments: savedEnvironments.map(({ label }) => label).join(", "),
                }),
              ]
            : []),
        ].join("\n"),
      });
    });
  };
}

export function useUpdateScopedSettings() {
  const { scope, environments, environment } = useSettingsScope();
  const run = useRunScopedSettingsPlan();
  return (patch: ScopedSettingsPatch, options?: ScopedSettingsWriteOptions) =>
    run(
      planScopedSettingsPatch(scope, environments, patch, environment?.environmentId ?? null),
      options,
    );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedSettingsPlan();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(planScopedSettingsClear(context.scope, context.environments, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedSettingsPlan();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(planProjectOverridesClear(context.environments, entries, keys));
  };
}

/** Says where an all-machines save of a shared setting lands; null while it lands on every machine. */
export function useSharedScopeNotice(): string | null {
  const context = useOptionalSettingsScope();
  return context?.scope.kind === "all" && hasSharedSettingsGroup(context.environments)
    ? t("Shared settings are saved only on the machines that follow them.")
    : null;
}

export function useScopedSettingsWriteAllowed() {
  const { connectedEnvironments } = useSettingsScope();
  const writable = useEnvironmentsWithScope(connectedEnvironments, AuthSettingsWriteScope);
  return (
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every((target) => writable.has(target.environmentId))
  );
}
