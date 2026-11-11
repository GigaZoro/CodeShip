import { Link } from "@tanstack/react-router";
import { SettingsGroup } from "./SettingsGroup";
import { t, tx } from "~/i18n";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type AcpRegistryUrlAuthAction,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  resolveEnvironmentMachineKind,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { PlusIcon } from "lucide-react";
import { createContext, use, useRef, useState, type ReactNode } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
  useUpdateEnvironmentModelPreferences,
  useToggleEnvironmentModelFavorite,
} from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import {
  EMPTY_SERVER_PROVIDERS,
  providersIgnoringCheckedAtAtom,
  serverEnvironment,
} from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
  type ProviderSettingsUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderUpdatesAction } from "../ProviderUpdatesAction";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import { useManagedPolicy } from "~/state/managedPolicy";
import { ExpandableText } from "./ExpandableText";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { AccountFailoverSettings } from "./AccountFailoverSettings";
import { useSecretSources } from "./SecretSourceInput";
import { UsageProviderSettings } from "./UsageProviderSettings";
import { ProviderSetupSection, readAntigravityAuthMethod } from "./ProviderSetupSection";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { CodexSetupSection, CodexManagedRuntimeFields } from "./CodexSetupSection";
import { readCodexSetupMode } from "./CodexSetupSection.logic";
import { providerClients } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  buildProviderEnvironmentOptions,
  buildProviderInstanceOverridePatch,
  classifyProviderEnvironmentAccess,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolveRemoteOperateAccess,
} from "./ProviderSettingsPanel.logic";

function modelListChanges(current: ReadonlyArray<string>, next: ReadonlyArray<string>) {
  const currentSet = new Set(current);
  const nextSet = new Set(next.map((model) => model.trim()).filter(Boolean));
  return [...new Set([...currentSet, ...nextSet])]
    .filter((model) => currentSet.has(model) !== nextSet.has(model))
    .map((model) => ({ model, selected: nextSet.has(model) }));
}

function providerConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PROVIDER_SETTINGS = providerClients.definitions.map((definition) => ({
  provider: definition.driverKind,
  hasDefaultInstance: definition.hasDefaultInstance !== false,
}));

function configuredBinaryPath(config: unknown): string {
  if (config === null || typeof config !== "object" || !("binaryPath" in config)) return "";
  return typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
}

// Subscribe only in the label because every status push restamps all providers' checkedAt.
function ProviderLastChecked({ environmentId }: { environmentId: EnvironmentId }) {
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;
  const lastCheckedRelative = useRelativeTimeState(lastCheckedAt);

  if (lastCheckedRelative.status === "missing") {
    return null;
  }

  if (lastCheckedRelative.status === "invalid") {
    return <span>{t("Checked unavailable")}</span>;
  }

  return (
    <span>
      {lastCheckedRelative.suffix
        ? tx("Checked {time}", {
            time: (
              <>
                <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
                {lastCheckedRelative.suffix}
              </>
            ),
          })
        : t("Checked {time}", { time: lastCheckedRelative.value })}
    </span>
  );
}

const providerCardHeightClassName =
  "@min-[48rem]/providers:h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/providers:min-h-[32rem]";

function ProviderSettingsPlaceholder({
  icon,
  title,
  description,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting("providers")} variant="plain">
      <SettingsGroup
        divided={false}
        className={cn(
          providerCardHeightClassName,
          "scrollbar-gutter-both flex overflow-x-hidden overflow-y-auto",
        )}
      >
        <Empty>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </SettingsGroup>
    </SettingsSection>
  );
}

function EnvironmentUnavailablePlaceholder({
  environment,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? t("Loading provider settings")
    : access.kind === "error"
      ? t("Could not connect to this device")
      : t("Provider settings are unavailable");
  const description = isLoading
    ? access.reason === "permissions"
      ? t("Checking what this session is allowed to change.")
      : t("Waiting for {device}'s configuration.", { device: environment.label })
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // Wedged devices can remain here indefinitely; a spinner would continuously repaint.
  return (
    <ProviderSettingsPlaceholder
      icon={
        <EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(environment.serverConfig)} />
      }
      title={title}
      description={description}
    >
      {error ? (
        <ExpandableText
          key={environment.environmentId}
          text={error}
          className="w-full text-left font-mono text-xs leading-relaxed text-muted-foreground"
        />
      ) : null}
    </ProviderSettingsPlaceholder>
  );
}

interface ProviderSettingsTarget {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly environmentIds?: readonly EnvironmentId[];
  readonly projectIds?: readonly ProjectId[];
}

export type ProviderSettingsView = "providers" | "models";

/** Which half of a machine's provider settings to render: its providers, or its per-machine models. */
const ProviderSettingsViewContext = createContext<ProviderSettingsView | null>(null);

export function ProviderSettingsPanel({
  view,
  children,
  machineSections = true,
  ...target
}: ProviderSettingsTarget & {
  readonly view?: ProviderSettingsView;
  /** Sections rendered above this machine's own sections. */
  readonly children?: ReactNode;
  /** False leaves out the per-machine sections, for a scope that spans several machines. */
  readonly machineSections?: boolean;
}) {
  return (
    <SettingsPageContainer className="@container/providers gap-8">
      {children}
      {machineSections ? (
        <ProviderSettingsViewContext value={view ?? null}>
          <ProviderSettingsPanelContent
            key={`${target.environmentId ?? ""}:${target.instanceId ?? ""}`}
            {...target}
          />
        </ProviderSettingsViewContext>
      ) : null}
    </SettingsPageContainer>
  );
}

function ProviderSettingsPanelContent(target: ProviderSettingsTarget) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = buildProviderEnvironmentOptions(
    environments,
    primaryEnvironmentId,
    target.environmentIds,
  );
  const targetEnvironmentMissing =
    target.environmentId !== undefined &&
    !options.some((environment) => environment.environmentId === target.environmentId);
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === target.environmentId) ?? null;

  return (
    <>
      {targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title={t("Device unavailable")}
          description={t("Reconnect this device to set up its provider, or select another device.")}
        />
      ) : null}
      {options.length === 0 && !targetEnvironmentMissing ? (
        <ProviderSettingsPlaceholder
          icon={<EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(null)} />}
          title={isReady ? t("No connected devices") : t("Loading devices")}
          description={
            isReady
              ? t("Connect an execution environment before configuring providers.")
              : t("Reading connected execution environments.")
          }
        />
      ) : null}

      {selectedEnvironment ? (
        <RemoteSessionGatedProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          targetInstanceId={
            target.environmentId === undefined ||
            selectedEnvironment.environmentId === target.environmentId
              ? target.instanceId
              : undefined
          }
          projectIds={target.projectIds ?? []}
        />
      ) : null}
    </>
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  targetInstanceId,
  projectIds,
}: {
  readonly environment: EnvironmentPresentation;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds: readonly ProjectId[];
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      targetInstanceId={targetInstanceId}
      projectIds={projectIds}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  targetInstanceId,
  projectIds,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds: readonly ProjectId[];
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return <EnvironmentUnavailablePlaceholder environment={environment} access={access} />;
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
      targetInstanceId={targetInstanceId}
      projectIds={projectIds}
    />
  );
}

const NO_PROJECT_IDS: readonly ProjectId[] = [];
const NO_FAVORITES: UnifiedSettings["favorites"] = [];

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
  targetInstanceId,
  projectIds = NO_PROJECT_IDS,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  readonly projectIds?: readonly ProjectId[];
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const managedPolicy = useManagedPolicy(environmentId);
  // A policy that allows no provider leaves nothing to add.
  const canAddProvider =
    !readOnly && managedPolicy?.limits?.providers?.allowedDrivers?.length !== 0;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canRefreshProviders = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateModelPreferences = useUpdateEnvironmentModelPreferences(environmentId);
  const toggleModelFavorite = useToggleEnvironmentModelFavorite(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const serverProviders = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const serverSupportsAccountFailover = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.usageLimitAccountFailover === true,
  );
  const serverSupportsAutoMode = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.autoMode === true,
  );
  // Hide overrides on older servers that silently ignore providerInstances patches.
  const supportsProjectProviderOverrides = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.projectProviderInstanceOverrides === true,
  );
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const uninstallAcpRegistryManagedBinary = useAtomCommand(
    serverEnvironment.uninstallAcpRegistryManagedBinary,
    { reportFailure: false },
  );
  const acceptAcpRegistryUrlAuth = useAtomCommand(serverEnvironment.acceptAcpRegistryUrlAuth, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | null>(
    targetInstanceId ?? null,
  );
  const [updatingProviderInstanceIds, setUpdatingProviderInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const refreshingRef = useRef(false);
  const updatingInstanceIdsRef = useRef<Set<ProviderInstanceId>>(new Set());

  const acceptUrlAuthentication = useStableCallback(
    (instanceId: ProviderInstanceId, action: AcpRegistryUrlAuthAction) => {
      void acceptAcpRegistryUrlAuth({
        environmentId,
        input: { instanceId, elicitationId: action.elicitationId },
      }).then((result) => {
        if (result._tag === "Success" && !result.value.accepted) {
          toastManager.add({
            type: "warning",
            title: t("Authentication request expired"),
            description: t("Refresh the provider and start the authentication flow again."),
          });
          return;
        }
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: t("Could not continue authentication"),
            description:
              error instanceof Error ? error.message : t("The authentication request expired."),
          });
        }
      });
    },
  );

  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );

  const refreshProviders = () => {
    if (refreshingRef.current || !readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
      return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: { refreshModels: true, reloadSecrets: true },
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  };

  const runProviderUpdate = useStableCallback(
    async (
      candidate: Pick<ProviderSettingsUpdateCandidate, "driver" | "instanceId">,
      targetVersion?: string,
    ) => {
      if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
      // Guard re-entry with a ref; deferred state updates cannot gate dispatch.
      if (updatingInstanceIdsRef.current.has(candidate.instanceId)) {
        return;
      }
      updatingInstanceIdsRef.current.add(candidate.instanceId);
      setUpdatingProviderInstanceIds((previous) => new Set(previous).add(candidate.instanceId));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
          ...(targetVersion ? { targetVersion } : {}),
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Could not update {provider}", {
              provider: PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
            }),
            description:
              error instanceof Error
                ? error.message
                : t("The provider update command could not be started."),
          }),
        );
      }
      updatingInstanceIdsRef.current.delete(candidate.instanceId);
      setUpdatingProviderInstanceIds((previous) => {
        if (!previous.has(candidate.instanceId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.instanceId);
        return next;
      });
    },
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    /** Undefined for a default slot the user never configured. */
    readonly explicitInstance: ProviderInstanceConfig | undefined;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const isDirty = explicitInstance !== undefined;
    const hasDefaultSlot = providerSettings.hasDefaultInstance || explicitInstance !== undefined;
    if (
      hasDefaultSlot &&
      (driver === "codex" ||
        driver === "claudeAgent" ||
        isDirty ||
        resolveProviderInstanceEnabled(explicitInstance ?? { driver }) ||
        defaultInstanceId === targetInstanceId)
    ) {
      rows.push({
        instanceId: defaultInstanceId,
        explicitInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const targetInstanceMissing =
    targetInstanceId !== undefined &&
    selectedInstanceId === targetInstanceId &&
    !rows.some((row) => row.instanceId === targetInstanceId);
  const selectedRow =
    rows.find((row) => row.instanceId === selectedInstanceId) ??
    (targetInstanceMissing ? null : (rows[0] ?? null));

  const persistInstance = async (
    instanceId: ProviderInstanceId,
    next: ProviderInstanceConfig,
    textGenerationModelSelection?: Parameters<
      typeof buildProviderInstanceUpdatePatch
    >[0]["textGenerationModelSelection"],
  ) => {
    const { providerInstances: _providerInstances, ...patch } = buildProviderInstanceUpdatePatch({
      settings,
      instanceId,
      instance: next,
      textGenerationModelSelection,
    });
    const result = await persistProviderInstance(
      { operation: "upsert", instanceId, instance: next },
      patch,
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t("Could not update provider instance"),
        description: error instanceof Error ? error.message : t("The settings update failed."),
      });
    }
  };

  const updateInstance = useStableCallback(
    (
      instanceId: ProviderInstanceId,
      previous: ProviderInstanceConfig,
      next: ProviderInstanceConfig,
    ) => {
      const isDisabling = next.enabled === false && resolveProviderInstanceEnabled(previous);
      const shouldClearTextGen =
        isDisabling &&
        resolveAppModelSelectionState(settings, serverProviders).instanceId === instanceId &&
        readEnvironmentScope(environmentId, AuthSettingsWriteScope);
      void persistInstance(
        instanceId,
        next,
        shouldClearTextGen ? DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection : undefined,
      );
    },
  );

  const enableInstance = useStableCallback(
    (instanceId: ProviderInstanceId, next: ProviderInstanceConfig) =>
      persistInstance(instanceId, next),
  );

  const deleteInstance = useStableCallback(
    async (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
      const updateResult = await persistProviderInstance({
        operation: "remove",
        instanceId,
      });
      if (updateResult._tag === "Failure") {
        const error = squashAtomCommandFailure(updateResult);
        toastManager.add({
          type: "error",
          title: t("Could not delete provider instance"),
          description: error instanceof Error ? error.message : t("The settings update failed."),
        });
        return;
      }

      if (instance.driver !== ProviderDriverKind.make("acpRegistry")) return;
      if (providerConfigString(instance.config, "source") === "local") return;
      const agentId = providerConfigString(instance.config, "agentId");
      if (agentId === null) return;

      // Concurrent removals race client snapshots; let the server decide whether the agent remains in use.
      const uninstallResult = await uninstallAcpRegistryManagedBinary({
        environmentId,
        input: { agentId },
      });
      if (uninstallResult._tag === "Failure" && !isAtomCommandInterrupted(uninstallResult)) {
        const error = squashAtomCommandFailure(uninstallResult);
        toastManager.add({
          type: "warning",
          title: t("Provider deleted, but managed files remain"),
          description: error instanceof Error ? error.message : t("Managed binary cleanup failed."),
        });
      }
    },
  );

  const resetDefaultInstance = useStableCallback(async (driverKind: ProviderDriverKind) => {
    const result = await persistProviderInstance({
      operation: "remove",
      instanceId: defaultInstanceIdForDriver(driverKind),
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t("Could not reset provider instance"),
        description: error instanceof Error ? error.message : t("The settings update failed."),
      });
    }
  });

  const writeProjectOverride = useStableCallback(
    (instanceId: ProviderInstanceId, next: boolean | undefined) => {
      updateSettings({
        projectSettingsOverrides: buildProviderInstanceOverridePatch(
          settings,
          projectIds,
          instanceId,
          next,
        ),
      });
    },
  );

  const stableUpdateModelPreferences = useStableCallback(updateModelPreferences);
  const stableToggleModelFavorite = useStableCallback(toggleModelFavorite);
  const actions: ProviderInstanceRowActions = {
    acceptUrlAuthentication,
    runProviderUpdate,
    updateInstance,
    enableInstance,
    deleteInstance,
    resetDefaultInstance,
    writeProjectOverride,
    updateModelPreferences: stableUpdateModelPreferences,
    toggleModelFavorite: stableToggleModelFavorite,
    selectInstance: setSelectedInstanceId,
  };
  // resolveModelPreferences falls back to a fresh `[]`; keep it stable for the rows.
  const favorites = settings.favorites.length > 0 ? settings.favorites : NO_FAVORITES;

  const representativeProjectId = projectIds[0];
  const renderProviderInstance = (row: InstanceRow, mode: "list" | "editor") => {
    const showProjectOverride =
      representativeProjectId !== undefined && supportsProjectProviderOverrides;
    return (
      <ProviderInstanceRow
        key={row.instanceId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        instanceId={row.instanceId}
        driver={row.driver}
        explicitInstance={row.explicitInstance}
        isDefault={row.isDefault}
        isDirty={row.isDirty === true}
        mode={mode}
        selected={mode === "list" && selectedRow?.instanceId === row.instanceId}
        readOnly={readOnly}
        canWriteSettings={canWriteSettings}
        liveProvider={serverProviders.find((candidate) => candidate.instanceId === row.instanceId)}
        isUpdateDispatching={updatingProviderInstanceIds.has(row.instanceId)}
        showProjectOverride={showProjectOverride}
        projectOverrideValue={
          showProjectOverride
            ? settings.projectSettingsOverrides[representativeProjectId]?.providerInstances?.[
                row.instanceId
              ]?.enabled
            : undefined
        }
        projectOverrideEffectiveEnabled={
          showProjectOverride
            ? resolveProjectProviderInstanceEnabled(
                settings,
                representativeProjectId,
                row.instanceId,
              )
            : false
        }
        modelPreferences={settings.providerModelPreferences?.[row.instanceId]}
        favorites={favorites}
        actions={actions}
      />
    );
  };

  const view = use(ProviderSettingsViewContext);
  const showsProviders = view !== "models";
  const showsModels = view !== "providers";

  return (
    <>
      {showsProviders ? (
        <SettingsSection
          {...searchableSetting("providers")}
          variant="plain"
          titleAction={
            canAddProvider ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      onClick={() => setIsAddInstanceDialogOpen(true)}
                      aria-label={t("Add provider")}
                    >
                      <PlusIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{t("Add provider")}</TooltipPopup>
              </Tooltip>
            ) : null
          }
          headerAction={
            // The ghost button's padding would inset its label, so pull the text to the card edge.
            <div className="-me-2 flex min-w-0 items-center gap-2">
              <ProviderUpdatesAction />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={isRefreshingProviders || !canRefreshProviders}
                      aria-busy={isRefreshingProviders}
                      onClick={() => void refreshProviders()}
                    >
                      <RefreshIcon refreshing={isRefreshingProviders} />
                      <span className="sr-only">{t("Refresh provider status")}</span>
                      <span className="hidden min-w-0 truncate sm:inline">
                        {isRefreshingProviders ? (
                          t("Refreshing providers")
                        ) : (
                          <ProviderLastChecked environmentId={environmentId} />
                        )}
                      </span>
                    </Button>
                  }
                />
                <TooltipPopup side="top">{t("Refresh provider status")}</TooltipPopup>
              </Tooltip>
            </div>
          }
        >
          {readOnly ? (
            <SettingsGroup divided={false} className="overflow-hidden">
              <SettingsRow
                title={t("Limited permissions")}
                description={t(
                  "This session can view {device}'s providers but can't change their settings.",
                  { device: environmentLabel },
                )}
              />
            </SettingsGroup>
          ) : null}
          <SettingsGroup
            divided={false}
            className={cn(
              providerCardHeightClassName,
              "overflow-hidden @min-[48rem]/providers:grid @min-[48rem]/providers:grid-cols-[17rem_minmax(0,1fr)]",
            )}
          >
            <div className="border-b border-border/60 bg-muted/10 @min-[48rem]/providers:flex @min-[48rem]/providers:min-h-0 @min-[48rem]/providers:flex-col @min-[48rem]/providers:border-r @min-[48rem]/providers:border-b-0">
              <ScrollArea
                scrollFade
                chainVerticalScroll
                className="@min-[48rem]/providers:min-h-0 @min-[48rem]/providers:flex-1"
              >
                <div className="divide-y divide-border/50">
                  {rows.map((row) => renderProviderInstance(row, "list"))}
                  {canAddProvider ? (
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 focus-visible:text-foreground sm:px-4"
                      onClick={() => setIsAddInstanceDialogOpen(true)}
                    >
                      <PlusIcon className="size-4 shrink-0" />
                      {t("Add provider")}
                    </button>
                  ) : null}
                </div>
              </ScrollArea>
            </div>

            <div data-provider-detail className="min-w-0 @min-[48rem]/providers:min-h-0">
              {selectedRow ? (
                <ScrollArea
                  scrollFade
                  chainVerticalScroll
                  className="@min-[48rem]/providers:h-full"
                >
                  {/* Flat sections run dividers edge to edge and inset text like the list beside them. */}
                  <div className="space-y-6 py-4">
                    {renderProviderInstance(selectedRow, "editor")}
                  </div>
                </ScrollArea>
              ) : (
                <div className="p-6 text-sm text-muted-foreground">
                  {targetInstanceMissing
                    ? t("This provider instance is no longer available on this device.")
                    : t("No providers configured.")}
                </div>
              )}
            </div>
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      {showsModels && serverSupportsAccountFailover ? (
        <AccountFailoverSettings
          environmentId={environmentId}
          settings={settings}
          providers={serverProviders}
          readOnly={readOnly || !canWriteSettings}
          supportsAutoMode={serverSupportsAutoMode}
        />
      ) : null}

      {showsProviders ? (
        <UsageProviderSettings
          key={environmentId}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={settings.usageLimitSources}
          cursorKeychainUsageEnabled={settings.cursorKeychainUsageEnabled}
          readOnly={readOnly}
        />
      ) : null}

      {showsProviders ? (
        <SettingsSection title={t("Background activity")}>
          <SettingsRow
            title={t("Health check interval")}
            description={t(
              "Configure provider polling in Maintenance & about → Background activity.",
            )}
            control={
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link
                    to="/settings/maintenance"
                    search={{}}
                    hash="provider-health-check-interval"
                  />
                }
              >
                {t("Open")}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      {isAddInstanceDialogOpen && !readOnly ? (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          onOpenChange={setIsAddInstanceDialogOpen}
          onCreated={setSelectedInstanceId}
        />
      ) : null}
    </>
  );
}

interface ProviderInstanceRowActions {
  readonly acceptUrlAuthentication: (
    instanceId: ProviderInstanceId,
    action: AcpRegistryUrlAuthAction,
  ) => void;
  readonly runProviderUpdate: (
    candidate: Pick<ProviderSettingsUpdateCandidate, "driver" | "instanceId">,
    targetVersion?: string,
  ) => Promise<void>;
  readonly updateInstance: (
    instanceId: ProviderInstanceId,
    previous: ProviderInstanceConfig,
    next: ProviderInstanceConfig,
  ) => void;
  readonly enableInstance: (
    instanceId: ProviderInstanceId,
    next: ProviderInstanceConfig,
  ) => Promise<void>;
  readonly deleteInstance: (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  ) => Promise<void>;
  readonly resetDefaultInstance: (driverKind: ProviderDriverKind) => Promise<void>;
  readonly writeProjectOverride: (
    instanceId: ProviderInstanceId,
    next: boolean | undefined,
  ) => void;
  readonly updateModelPreferences: ReturnType<typeof useUpdateEnvironmentModelPreferences>;
  readonly toggleModelFavorite: ReturnType<typeof useToggleEnvironmentModelFavorite>;
  readonly selectInstance: (instanceId: ProviderInstanceId) => void;
}

const NO_MODELS: ReadonlyArray<string> = [];

const CLAUDE_TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";

/** Only the default provider inherits the machine's token; the server drops a blank one to hide it. */
function ClaudeTokenAccountRow({
  instance,
  isDefault,
  onChange,
}: {
  readonly instance: ProviderInstanceConfig;
  readonly isDefault: boolean;
  readonly onChange: (next: ProviderInstanceConfig) => void;
}) {
  const { environment = [], ...rest } = instance;
  const otherVariables = environment.filter((variable) => variable.name !== CLAUDE_TOKEN_VARIABLE);
  const usesMachineToken =
    isDefault &&
    !environment.some(
      (variable) =>
        variable.name === CLAUDE_TOKEN_VARIABLE &&
        (variable.valueRedacted === true ||
          typeof variable.value !== "string" ||
          variable.value.trim().length > 0),
    );
  return (
    <SettingsRow
      title={t("Account")}
      description={
        usesMachineToken
          ? t(
              "Using the CLAUDE_CODE_OAUTH_TOKEN set on this machine. Ignore it to sign this provider in instead.",
            )
          : t(
              "Using the CLAUDE_CODE_OAUTH_TOKEN in this provider's environment variables. Remove it to sign in.",
            )
      }
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onChange(
              usesMachineToken
                ? {
                    ...rest,
                    environment: [
                      ...otherVariables,
                      { name: CLAUDE_TOKEN_VARIABLE, value: "", sensitive: false },
                    ],
                  }
                : otherVariables.length > 0
                  ? { ...rest, environment: otherVariables }
                  : rest,
            )
          }
        >
          {usesMachineToken ? t("Ignore token") : t("Remove token")}
        </Button>
      }
    />
  );
}

/** Stable props let this boundary return cached cards even when settings rebuild parent row elements. */
function ProviderInstanceRow({
  environmentId,
  environmentLabel,
  instanceId,
  driver,
  explicitInstance,
  isDefault,
  isDirty,
  mode,
  selected,
  readOnly,
  canWriteSettings,
  liveProvider,
  isUpdateDispatching,
  showProjectOverride,
  projectOverrideValue,
  projectOverrideEffectiveEnabled,
  modelPreferences,
  favorites,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly explicitInstance: ProviderInstanceConfig | undefined;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
  readonly mode: "list" | "editor";
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly liveProvider: ServerProvider | undefined;
  readonly isUpdateDispatching: boolean;
  readonly showProjectOverride: boolean;
  readonly projectOverrideValue: boolean | undefined;
  readonly projectOverrideEffectiveEnabled: boolean;
  readonly modelPreferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly favorites: UnifiedSettings["favorites"];
  readonly actions: ProviderInstanceRowActions;
}) {
  const allProjects = useProjects();
  const secretSources = useSecretSources(environmentId);
  const acpProjects =
    mode === "editor" && liveProvider?.driver === "acpRegistry"
      ? allProjects.filter((project) => project.environmentId === environmentId)
      : undefined;
  const instance = explicitInstance ?? { driver };
  const driverOption = providerClients.get(driver);
  const updateCandidate =
    liveProvider !== undefined && isProviderSettingsUpdateCandidate(liveProvider)
      ? liveProvider
      : undefined;
  const isInstanceUpdateRunning =
    isUpdateDispatching || (liveProvider !== undefined && isProviderUpdateActive(liveProvider));
  const hiddenModels = modelPreferences?.hiddenModels ?? NO_MODELS;
  const modelOrder = modelPreferences?.modelOrder ?? NO_MODELS;
  const favoriteModels = Arr.filterMap(favorites, (favorite) =>
    favorite.provider === instanceId ? Result.succeed(favorite.model) : Result.failVoid,
  );
  const resetLabel = driverOption?.label ?? String(driver);
  const projectOverride = showProjectOverride
    ? {
        value: projectOverrideValue,
        effectiveEnabled: projectOverrideEffectiveEnabled,
        onChange: (next: boolean) => actions.writeProjectOverride(instanceId, next),
        onReset: () => actions.writeProjectOverride(instanceId, undefined),
      }
    : undefined;
  const codexSetupMode = driver === "codex" ? readCodexSetupMode(instance.config) : null;
  const recommendedVersion = liveProvider?.compatibilityAdvisory?.recommendedVersion;
  const canInstallRecommended =
    !readOnly &&
    liveProvider !== undefined &&
    Boolean(liveProvider.compatibilityAdvisory?.message) &&
    Boolean(recommendedVersion) &&
    liveProvider.versionAdvisory?.canInstallVersion === true;

  return (
    <ProviderInstanceCard
      environmentId={environmentId}
      secretSources={secretSources}
      acpProjects={acpProjects}
      projectOverride={projectOverride}
      onAcceptUrlAuth={
        readOnly ? undefined : (action) => actions.acceptUrlAuthentication(instanceId, action)
      }
      instanceId={instanceId}
      instance={instance}
      driverOption={driverOption}
      liveProvider={liveProvider}
      mode={mode}
      selected={selected}
      onSelect={mode === "list" ? () => actions.selectInstance(instanceId) : undefined}
      readOnly={readOnly}
      runtime={
        mode === "editor" && codexSetupMode === "managed" ? (
          <CodexManagedRuntimeFields
            environmentId={environmentId}
            instanceId={instanceId}
            provider={liveProvider}
          />
        ) : undefined
      }
      canWriteSettings={canWriteSettings}
      setup={
        mode === "editor" && driver === "antigravity" ? (
          <ProviderSetupSection
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={liveProvider}
            binaryPath={configuredBinaryPath(instance.config)}
            authMethod={readAntigravityAuthMethod(instance.config)}
            enabled={resolveProviderInstanceEnabled(instance)}
            readOnly={readOnly}
            onEnable={() => actions.enableInstance(instanceId, { ...instance, enabled: true })}
          />
        ) : mode === "editor" && codexSetupMode === "managed" ? (
          <CodexSetupSection
            environmentId={environmentId}
            instanceId={instanceId}
            provider={liveProvider}
            mode={codexSetupMode}
            enabled={resolveProviderInstanceEnabled(instance)}
            readOnly={readOnly}
            onModeChange={(setupMode) =>
              actions.enableInstance(instanceId, {
                ...instance,
                enabled: true,
                config: {
                  ...(instance.config !== null && typeof instance.config === "object"
                    ? instance.config
                    : {}),
                  enabled: true,
                  setupMode,
                },
              })
            }
          />
        ) : mode === "editor" &&
          !readOnly &&
          liveProvider &&
          (liveProvider.setup?.canAuthenticate ||
            (liveProvider.driver === "acpRegistry" && liveProvider.installed)) ? (
          <ProviderAuthenticationSection
            key={`${environmentId}:${instanceId}`}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={liveProvider}
            readOnly={readOnly}
          />
        ) : mode === "editor" &&
          !readOnly &&
          driver === "cursor" &&
          liveProvider?.setup?.canAuthenticate === false ? (
          <SettingsRow
            title={t("Cursor account")}
            description={t(
              "Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in.",
            )}
          />
        ) : mode === "editor" &&
          !readOnly &&
          driver === "claudeAgent" &&
          liveProvider?.setup?.canAuthenticate === false &&
          liveProvider.auth.type === "oauthToken" ? (
          <ClaudeTokenAccountRow
            instance={instance}
            isDefault={isDefault}
            onChange={(next) => actions.updateInstance(instanceId, instance, next)}
          />
        ) : null
      }
      onUpdate={(next) => actions.updateInstance(instanceId, instance, next)}
      onDelete={
        mode === "editor" && !isDefault
          ? () => actions.deleteInstance(instanceId, instance)
          : undefined
      }
      headerAction={
        mode === "editor" && isDefault && isDirty ? (
          <SettingResetButton
            label={t("{name} provider settings", { name: resetLabel })}
            onClick={() => actions.resetDefaultInstance(driver)}
          />
        ) : null
      }
      hiddenModels={hiddenModels}
      favoriteModels={favoriteModels}
      modelOrder={modelOrder}
      onHiddenModelsChange={(next, affectedModels) => {
        const hidden = new Set(next);
        void actions.updateModelPreferences({
          setModelsHidden: affectedModels.map((model) => ({
            provider: instanceId,
            model,
            hidden: hidden.has(model),
          })),
        });
      }}
      onToggleFavorite={(model) => {
        void actions.toggleModelFavorite(instanceId, model);
      }}
      onFavoriteModelsChange={(next) => {
        void actions.updateModelPreferences({
          setModelFavorites: modelListChanges(favoriteModels, next).map(({ model, selected }) => ({
            provider: instanceId,
            model,
            favorite: selected,
          })),
        });
      }}
      onModelOrderChange={(nextOrder) => {
        void actions.updateModelPreferences({
          setProviderModelOrder: { provider: instanceId, modelOrder: nextOrder },
        });
      }}
      onInstallRecommended={
        canInstallRecommended
          ? () => {
              void actions.runProviderUpdate(liveProvider, recommendedVersion ?? undefined);
            }
          : undefined
      }
      onRunUpdate={
        !readOnly && updateCandidate
          ? () => {
              if (!isInstanceUpdateRunning) void actions.runProviderUpdate(updateCandidate);
            }
          : undefined
      }
      isUpdating={isInstanceUpdateRunning}
    />
  );
}
