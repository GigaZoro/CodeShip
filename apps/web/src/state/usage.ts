import { useAtomValue } from "@effect/atom-react";
import { t } from "~/i18n";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  needsCursorKeychainAccess,
  refreshUsage,
  usageSummaryInput,
} from "@t3tools/client-runtime/state/usage";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";
import { environmentSession, readEnvironmentScope } from "./session";

import {
  equalUsageStatuses,
  isKeptUsage,
  nextUsageRequest,
  settleUsageScanFailures,
  settleUsageSnapshot,
  usageWindowKey,
  type EnvironmentUsageStatus,
  type UsageScanFailures,
  type UsageSnapshot,
} from "@t3tools/client-runtime/state/usage-progress";

export type { EnvironmentUsageStatus } from "@t3tools/client-runtime/state/usage-progress";
export { mergeAnsweredUsage } from "@t3tools/client-runtime/state/usage-progress";

const usageByWindowAtom = Atom.family((windowKey: string | null) =>
  Atom.make((get): readonly EnvironmentUsageStatus[] => {
    const input = windowKey === null ? null : (JSON.parse(windowKey) as UsageSummaryInput);
    const presentations = get(environmentPresentations.presentationsAtom);

    const statuses: EnvironmentUsageStatus[] = [];
    for (const [environmentId, presentation] of presentations) {
      const isConnected = presentation.connection.phase === "connected";
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const access = resolveUsageAccess({
        connection: presentation.connection,
        session: AsyncResult.getOrElse(sessionResult, () => null),
        hasSessionError: sessionResult._tag === "Failure",
      });
      const modelFilter =
        input === null ? undefined : get(serverEnvironment.usageModelFilterAtom(environmentId));
      if (input === null || !access.canReadDiagnostics) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isConnected,
          ...access,
          modelFilter,
          summary: null,
          needsCursorKeychainAccess: false,
        });
        continue;
      }
      const result = get(
        serverEnvironment.usageSummary({
          environmentId,
          input: usageSummaryInput(input, modelFilter),
        }),
      );
      const summary = AsyncResult.getOrElse(result, () => null);
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isPending: result.waiting || result._tag === "Initial",
        modelFilter,
        canReadDiagnostics: true,
        isConnected,
        error:
          result._tag === "Failure"
            ? t("This environment could not report usage: {error}", {
                error: formatEnvironmentQueryError(result.cause),
              })
            : null,
        summary,
        needsCursorKeychainAccess:
          summary?.sources.some((source) => source.action === "enableCursorKeychain") === true &&
          needsCursorKeychainAccess(
            summary,
            get(serverEnvironment.providersValueAtom(environmentId)),
          ),
      });
    }
    return statuses;
  }).pipe(Atom.withEquality(equalUsageStatuses), Atom.withLabel(`web-usage:window:${windowKey}`)),
);

export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null = null,
  hiddenProviders: readonly UsageProviderKind[] = [],
  { advanceWindow = true, enabled = true } = {},
) {
  const [request, setRequest] = useState(() => ({
    window: input,
    failedThrough: null as string | null,
    enabled,
  }));
  const requestedWindow = enabled && !request.enabled ? input : request.window;
  const environments = useAtomValue(
    usageByWindowAtom(enabled ? usageWindowKey(requestedWindow) : null),
  );
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter(({ environmentId }) => selectedEnvironmentIds.has(environmentId));
  const [savedFailures, setSavedFailures] = useState<UsageScanFailures | null>(null);
  const failures = enabled
    ? settleUsageScanFailures(savedFailures, requestedWindow, selectedEnvironments, hiddenProviders)
    : null;
  if (failures !== savedFailures) setSavedFailures(failures);
  const [previous, setPrevious] = useState<UsageSnapshot | null>(null);
  const shown = enabled
    ? settleUsageSnapshot(
        previous,
        requestedWindow,
        environments,
        selectedEnvironments,
        hiddenProviders,
      )
    : null;
  if (enabled && shown !== previous) setPrevious(shown);
  const next = nextUsageRequest(request, input, selectedEnvironments, advanceWindow, enabled);
  if (next !== request) setRequest(next);

  const refresh = (nextInput = requestedWindow) => {
    if (!enabled) return Promise.resolve();
    return refreshUsage({
      registry: appAtomRegistry,
      server: serverEnvironment,
      presentations: environmentPresentations,
      environmentIds: selectedEnvironments
        .filter(
          (environment) =>
            environment.canReadDiagnostics &&
            readEnvironmentScope(environment.environmentId, AuthDiagnosticsReadScope),
        )
        .map(({ environmentId }) => environmentId),
      input: nextInput,
    });
  };

  return {
    requestedWindow,
    failures,
    environments,
    selectedEnvironments,
    shown,
    showingKept: isKeptUsage(shown, input, selectedEnvironments, hiddenProviders),
    refresh,
  };
}
