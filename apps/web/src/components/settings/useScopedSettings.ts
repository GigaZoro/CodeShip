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
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import {
  createScopedSettingsWriter,
  pendingScopedWritesAtom,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  sharedSaveSummary,
  settlePendingScopedWrites,
  type ProjectOverrideEntry,
  type SavedScopedServerWrite,
  type ScopedSettingsPatch,
  type ScopedSettingsPlan,
} from "./scopedSettings";

const readSettings = (environmentId: EnvironmentId) =>
  readEnvironment(environmentId)?.serverConfig?.settings ?? null;
const writeScopedSettings = createScopedSettingsWriter(readSettings);

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

function useRunScopedPlanner() {
  const updateServer = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const shareServer = useAtomCommand(serverEnvironment.shareSettings, { reportFailure: false });
  return (
    environments: Parameters<typeof writeScopedSettings>[0],
    planner: Parameters<typeof writeScopedSettings>[1],
    options?: ScopedSettingsWriteOptions,
  ) => {
    const plan = planner(environments);
    if (plan.unavailableReason) {
      toastManager.add({
        type: "warning",
        title: t("Setting not saved"),
        description: plan.unavailableReason,
      });
      options?.onFailed?.();
      return;
    }
    const save = {};
    const settledEnvironments = new Set<EnvironmentId>();
    const settle = (environmentId: EnvironmentId, saved?: ServerSettings) => {
      settledEnvironments.add(environmentId);
      appAtomRegistry.update(pendingScopedWritesAtom, (writes) =>
        settlePendingScopedWrites(
          writes,
          { save, environmentId },
          (id) => readSettings(id) ?? undefined,
          saved,
        ),
      );
    };
    appAtomRegistry.update(pendingScopedWritesAtom, (writes) => [
      ...writes,
      ...plan.serverWrites.map(({ environmentId, patch }) => ({ save, environmentId, patch })),
    ]);
    void writeScopedSettings(
      environments,
      planner,
      {
        update: async (request) => {
          const result =
            missingSettingsGrant(request) ??
            (await updateServer(request).catch((error: unknown) => {
              settle(request.environmentId);
              throw error;
            }));
          settle(request.environmentId, result._tag === "Success" ? result.value : undefined);
          return result;
        },
        share: async (request) => {
          const result =
            missingSettingsGrant(request) ??
            (await shareServer(request).catch((error: unknown) => {
              settle(request.environmentId);
              throw error;
            }));
          settle(
            request.environmentId,
            result._tag === "Success" ? result.value.settings : undefined,
          );
          return result;
        },
      },
      persistClientSettingsPatch,
    ).then(({ failedEnvironments, savedEnvironments, savedEnvironmentCount }) => {
      // A follower held back because its authority failed was never sent a request to settle it.
      for (const { environmentId } of plan.serverWrites) {
        if (!settledEnvironments.has(environmentId)) settle(environmentId);
      }
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

/** Runs a plan built elsewhere; it is sent as planned, since only the settings page can replan it. */
export function useRunScopedSettingsPlan() {
  const run = useRunScopedPlanner();
  return (plan: ScopedSettingsPlan, options?: ScopedSettingsWriteOptions) =>
    run([], () => plan, options);
}

export function useUpdateScopedSettings() {
  const { scope, environments, environment, deviceOnly } = useSettingsScope();
  const run = useRunScopedPlanner();
  return (patch: ScopedSettingsPatch, options?: ScopedSettingsWriteOptions) =>
    run(
      environments,
      (current) =>
        planScopedSettingsPatch(scope, current, patch, {
          origin: environment?.environmentId ?? null,
          deviceOnly,
        }),
      options,
    );
}

export function useClearScopedSettings() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlanner();
  return (keys: readonly ProjectScopedServerSettingKey[]) => {
    if (context === null) return;
    run(context.environments, (current) => planScopedSettingsClear(context.scope, current, keys));
  };
}

export function useClearProjectOverrides() {
  const context = useOptionalSettingsScope();
  const run = useRunScopedPlanner();
  return (
    entries: readonly ProjectOverrideEntry[],
    keys: readonly ProjectScopedServerSettingKey[],
  ) => {
    if (context === null) return;
    run(context.environments, (current) => planProjectOverridesClear(current, entries, keys));
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
