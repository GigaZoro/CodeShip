import { DeviceHostUpdates } from "../device/DeviceHostUpdates";
import { DeviceToolVersions } from "../device/DeviceToolVersions";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { DeviceSourcesSettings } from "./DeviceSourcesSettings";
import {
  AuthSettingsWriteScope,
  BrowserImportFailureReason,
  BROWSER_PROFILE_MAX_COUNT,
  type BrowserAssistantKind,
  BrowserAssistantKind as BrowserAssistantKindSchema,
  browserAssistantKey,
  type BrowserLinkTarget,
  type BrowserProfile,
  BrowserSearchEngine,
  BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH,
  type EnvironmentId,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  BROWSER_RECORDING_FRAME_RATES,
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_LINK_TARGET,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  DEFAULT_BROWSER_SEARCH_ENGINE,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  DEFAULT_SERVER_SETTINGS,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type BrowserImportSource,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { managedCapabilityDenial } from "@t3tools/shared/managedPolicyMessages";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { isValidSearchUrlTemplate } from "@t3tools/shared/preview";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import { MoreVertical, Plus as PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import {
  BROWSER_ASSISTANTS,
  browserAssistantLabel,
  useBrowserAssistants,
} from "~/browser/browserAssistants";
import { resolveEnvironmentOptionLabel } from "~/components/BranchToolbar.logic";
import { previewBridge } from "~/components/preview/previewBridge";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatEnvironmentQueryError } from "~/state/query";
import { previewEnvironment } from "~/state/preview";
import { useServerConfigs } from "~/state/entities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentDeviceSetupStatus,
  DeviceHubSetupStatus,
  deviceHubReadiness,
} from "~/components/device/DeviceSetup";
import { isElectron } from "../../env";

import { Badge } from "../ui/badge";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { readLocalApi } from "~/localApi";

import { toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { SimlockHostsRow } from "./OptInFeatureRows";
import { searchableSetting } from "./settingsSearch";
import { AdvancedSettings } from "./AdvancedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { BrowserImportWizard, type WizardTarget } from "./BrowserImportWizard";
import type { ImportOutcome } from "./browserImportWizard.logic";
import { msg, t, tx, type Message } from "~/i18n";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

type BrowserProfileDataBridge = Pick<
  NonNullable<typeof previewBridge>,
  "clearCookies" | "clearCache"
>;

export interface ServerProfileData {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly clear: (environmentId: EnvironmentId, profileId: string) => Promise<void>;
}

export async function clearBrowserProfileData(
  bridge: BrowserProfileDataBridge | null,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
  server?: ServerProfileData,
): Promise<void> {
  const desktopEnvironmentIds = bridge === null ? [] : environmentIds;
  const serverEnvironmentIds = server?.environmentIds ?? [];
  if (desktopEnvironmentIds.length === 0 && serverEnvironmentIds.length === 0) {
    throw new Error("Browser profile data is not available to clear.");
  }
  await Promise.all([
    ...desktopEnvironmentIds.flatMap((environmentId) => [
      bridge!.clearCookies(environmentId, profileId),
      bridge!.clearCache(environmentId, profileId),
    ]),
    ...serverEnvironmentIds.map((environmentId) => server!.clear(environmentId, profileId)),
  ]);
}

function browserProfileRemovalAvailable(
  bridgeAvailable: boolean,
  environmentsReady: boolean,
  environmentCount: number,
  serverBrowserCount = 0,
): boolean {
  return (bridgeAvailable || serverBrowserCount > 0) && environmentsReady && environmentCount > 0;
}

const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, Message>> = {
  system: msg("System"),
  light: msg("Light"),
  dark: msg("Dark"),
};

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`;

/** IPC carries reason tokens inside messages; treat unknown tokens as read failures without exposing raw
 * text. */
class ProfileLimitReachedError extends Error {
  constructor() {
    super("Browser profile limit reached.");
    this.name = "ProfileLimitReachedError";
  }
}

export const importFailureReason = (cause: unknown): BrowserImportFailureReason => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    BrowserImportFailureReason.literals.find((reason) => message.includes(`failed: ${reason}.`)) ??
    "readFailed"
  );
};

/**
 * The desktop's refusal when the machine's managed policy forbids cookie import. IPC wraps the
 * message in its own prefixes, so the sentence is matched on the contract's wording.
 */
export const importPolicyRefusal = (cause: unknown): string | undefined => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? "");
  return (
    /The managed policy at .* importing browser cookies is not allowed\./u.exec(message)?.[0] ??
    /(?:^|: )([^:]*'s policy does not allow importing browser cookies\.)/u.exec(message)?.[1]
  );
};

async function importBrowserCookiesIntoTarget(
  bridge: NonNullable<typeof previewBridge>,
  source: BrowserImportSource,
  environmentId: EnvironmentId,
  input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
): Promise<ImportOutcome> {
  try {
    const result = await bridge.importBrowserCookies({
      environmentId,
      sourceId: source.id,
      sourceProfileDirectory: input.sourceProfileDirectory,
      targetProfileId: input.target.profileId,
    });
    if (
      input.target.kind === "existing" &&
      !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      )
    ) {
      return { kind: "blocked", reason: "readFailed" };
    }
    let targetName: string;
    if (input.target.kind === "new") {
      if (result.imported > 0) {
        try {
          const persisted = await persistClientSettingsUpdate((current) => {
            const existing = current.browserProfiles.find(
              (profile) => profile.id === input.target.profileId,
            );
            if (existing) return current;
            // The profile cap may be reached during import; enforce it against the updater's latest settings.
            if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) {
              throw new ProfileLimitReachedError();
            }
            const taken = new Set(
              resolveBrowserProfiles(current.browserProfiles).map((profile) => profile.name),
            );
            let name = source.name;
            for (let index = 2; taken.has(name); index += 1) name = `${source.name} ${index}`;
            return {
              ...current,
              browserProfiles: [
                ...current.browserProfiles,
                { id: input.target.profileId, name, kind: "persistent" as const },
              ],
            };
          });
          targetName =
            persisted.browserProfiles.find((profile) => profile.id === input.target.profileId)
              ?.name ?? source.name;
        } catch (cause) {
          // Clear the new target's partition on registration failure so imported cookies cannot outlive its
          // profile.
          await clearBrowserProfileData(bridge, [environmentId], input.target.profileId).catch(
            () => undefined,
          );
          const reason =
            cause instanceof ProfileLimitReachedError ? "profileLimitReached" : "profileNotSaved";
          throw new Error(`Importing cookies from ${source.id} failed: ${reason}.`, { cause });
        }
      } else {
        targetName = source.name;
      }
    } else {
      targetName = input.target.name;
    }
    return {
      kind: "imported",
      imported: result.imported,
      skipped: result.skipped,
      skippedDomains: result.skippedDomains,
      targetName,
    };
  } catch (cause) {
    const policyRefusal = importPolicyRefusal(cause);
    return policyRefusal !== undefined
      ? { kind: "blocked", reason: "readFailed", message: policyRefusal }
      : { kind: "blocked", reason: importFailureReason(cause) };
  }
}

const viewportSelectValue = (viewport: PreviewViewportSetting): string => {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  ) {
    return viewport.presetId;
  }
  return RESPONSIVE_VALUE;
};

/** Inline options lack an items map; bare SelectValue would display the stored fill token. */
const viewportSelectLabel = (viewport: PreviewViewportSetting): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return t("Fill panel");
  if (value === RESPONSIVE_VALUE) return t("Responsive");
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? t("Responsive");
};

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});

function BrowserViewportSetting() {
  const viewport = useClientSettings((settings) => settings.browserDefaultViewport);
  const updateSettings = useUpdatePrimarySettings();

  const sized = viewport._tag === "fill" ? null : viewport;
  const presentedSize = {
    width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
    height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
  };

  const selectViewport = (value: string | null) => {
    if (value === FILL_VALUE) {
      updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT });
      return;
    }
    if (value === RESPONSIVE_VALUE) {
      updateSettings({
        browserDefaultViewport: {
          _tag: "freeform",
          width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
          height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
        },
      });
      return;
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateSettings({
      browserDefaultViewport: {
        _tag: "preset",
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      },
    });
  };

  // Commit on blur to avoid persisting valid intermediate dimensions and rewriting settings per keystroke.
  const commitDimension = (axis: "width" | "height", value: number | null) => {
    if (value === null || !isValidDimension(value)) return;
    const next = { ...presentedSize, [axis]: value };
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return;
    if (sized && next.width === sized.width && next.height === sized.height) return;
    updateSettings({ browserDefaultViewport: { _tag: "freeform", ...next } });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-default-viewport")}
      description={t(
        "Tab size for you and agents. Fill fits the panel; other sizes show the device toolbar.",
      )}
      resetAction={
        viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label={t("default browser viewport")}
            onClick={() => updateSettings({ browserDefaultViewport: DEFAULT_BROWSER_VIEWPORT })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Select value={viewportSelectValue(viewport)} onValueChange={selectViewport}>
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-44"
              aria-label={t("Default browser viewport")}
            >
              <SelectValue>{viewportSelectLabel(viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={FILL_VALUE}>{t("Fill panel")}</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>{t("Responsive")}</SelectItem>
              <SelectGroup>
                <SelectGroupLabel>{t("Standard")}</SelectGroupLabel>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{preset.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {preset.detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>

          {sized ? (
            <div className="flex min-w-0 items-center gap-1">
              <NumberField
                value={presentedSize.width}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("width", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label={t("Default viewport width")} />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
              <NumberField
                value={presentedSize.height}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("height", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label={t("Default viewport height")} />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      aria-label={
                        presentedSize.height >= presentedSize.width
                          ? t("Rotate to landscape")
                          : t("Rotate to portrait")
                      }
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{t("Rotate")}</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function BrowserZoomSetting() {
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-zoom")}
      description={t("Page zoom applied to new browser tabs.")}
      resetAction={
        zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label={t("default browser zoom")}
            onClick={() =>
              updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
            }
          />
        ) : null
      }
      control={
        <Select
          value={String(zoomFactor)}
          onValueChange={(value) => {
            const next = PREVIEW_ZOOM_LEVELS.find((level) => String(level) === value);
            if (next !== undefined) updateSettings({ browserDefaultZoomFactor: next });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("Default browser zoom")}
          >
            <SelectValue>{zoomLabel(zoomFactor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PREVIEW_ZOOM_LEVELS.map((level) => (
              <SelectItem hideIndicator key={level} value={String(level)}>
                {zoomLabel(level)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserAppearanceSetting() {
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-appearance")}
      description={t("The color scheme pages are told to prefer. System follows your OS setting.")}
      resetAction={
        appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label={t("default browser appearance")}
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          value={appearance}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") {
              updateSettings({ browserDefaultAppearance: value });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("Default browser appearance")}
          >
            <SelectValue>{t(APPEARANCE_LABELS[appearance])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserRecordingInputSettings() {
  const showKeys = useClientSettings((settings) => settings.browserRecordingShowKeyPresses);
  const showMouse = useClientSettings((settings) => settings.browserRecordingShowMousePresses);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("browser-recording-key-presses")}
        description={t(
          "Show pressed keys and shortcuts in new recordings. Password fields are excluded.",
        )}
        control={
          <Switch
            checked={showKeys}
            aria-label={t("Show key presses in recordings")}
            onCheckedChange={(checked) =>
              updateSettings({ browserRecordingShowKeyPresses: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("browser-recording-mouse-presses")}
        description={t("Highlight mouse presses and held buttons in new recordings.")}
        control={
          <Switch
            checked={showMouse}
            aria-label={t("Show mouse presses in recordings")}
            onCheckedChange={(checked) =>
              updateSettings({ browserRecordingShowMousePresses: Boolean(checked) })
            }
          />
        }
      />
    </>
  );
}

function BrowserRecordingFrameRateSetting() {
  const frameRate = useClientSettings((settings) => settings.browserRecordingFrameRate);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-recording-frame-rate")}
      description={t("Maximum recording rate. 30 fps saves CPU and storage; 60 fps is smoother.")}
      resetAction={
        frameRate !== DEFAULT_BROWSER_RECORDING_FRAME_RATE ? (
          <SettingResetButton
            label={t("browser recording frame rate")}
            onClick={() =>
              updateSettings({ browserRecordingFrameRate: DEFAULT_BROWSER_RECORDING_FRAME_RATE })
            }
          />
        ) : null
      }
      control={
        <Select
          value={String(frameRate)}
          onValueChange={(value) => {
            const next = BROWSER_RECORDING_FRAME_RATES.find((rate) => String(rate) === value);
            if (next !== undefined) {
              updateSettings({ browserRecordingFrameRate: next });
            }
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label={t("Browser recording frame rate")}
          >
            <SelectValue>{t("{rate} fps", { rate: frameRate })}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {BROWSER_RECORDING_FRAME_RATES.map((rate) => (
              <SelectItem hideIndicator key={rate} value={String(rate)}>
                {t("{rate} fps", { rate })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const LINK_TARGET_LABELS: Readonly<Record<BrowserLinkTarget, Message>> = {
  system: msg("Your default browser"),
  app: msg("T3.CodeShip"),
};

function BrowserLinkTargetSetting() {
  const linkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-link-target")}
      description={t(
        "Where links in the chat and terminal open. Hold ⌘ or Ctrl while clicking a link to open it in your default browser either way.",
      )}
      resetAction={
        linkTarget !== DEFAULT_BROWSER_LINK_TARGET ? (
          <SettingResetButton
            label={t("link target")}
            onClick={() => updateSettings({ browserLinkTarget: DEFAULT_BROWSER_LINK_TARGET })}
          />
        ) : null
      }
      control={
        <Select
          value={linkTarget}
          onValueChange={(value) => {
            if (value === "system" || value === "app") {
              updateSettings({ browserLinkTarget: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Open links in")}>
            <SelectValue>{t(LINK_TARGET_LABELS[linkTarget])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(Object.keys(LINK_TARGET_LABELS) as ReadonlyArray<BrowserLinkTarget>).map((target) => (
              <SelectItem hideIndicator key={target} value={target}>
                {t(LINK_TARGET_LABELS[target])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const SEARCH_ENGINE_LABELS: Readonly<Record<BrowserSearchEngine, Message>> = {
  duckduckgo: msg("DuckDuckGo"),
  google: msg("Google"),
  bing: msg("Bing"),
  brave: msg("Brave Search"),
  kagi: msg("Kagi"),
  ecosia: msg("Ecosia"),
  custom: msg("Custom"),
};

function BrowserSearchEngineSetting() {
  const engine = useClientSettings((settings) => settings.browserSearchEngine);
  const customUrl = useClientSettings((settings) => settings.browserCustomSearchUrl);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <>
      <SettingsRow
        {...searchableSetting("browser-search-engine")}
        description={t("What the address bar searches when you type something that isn't a URL.")}
        resetAction={
          engine !== DEFAULT_BROWSER_SEARCH_ENGINE || customUrl !== "" ? (
            <SettingResetButton
              label={t("search engine")}
              onClick={() =>
                updateSettings({
                  browserSearchEngine: DEFAULT_BROWSER_SEARCH_ENGINE,
                  browserCustomSearchUrl: "",
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={engine}
            onValueChange={(value) => {
              const next = BrowserSearchEngine.literals.find((literal) => literal === value);
              if (next !== undefined) {
                updateSettings({ browserSearchEngine: next });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={t("Search engine")}>
              <SelectValue>{t(SEARCH_ENGINE_LABELS[engine])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BrowserSearchEngine.literals.map((literal) => (
                <SelectItem hideIndicator key={literal} value={literal}>
                  {t(SEARCH_ENGINE_LABELS[literal])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {engine === "custom" ? (
        <SettingsRow
          title={t("Custom search URL")}
          description={t("Use %s where the search terms go.")}
          status={
            isValidSearchUrlTemplate(customUrl)
              ? undefined
              : t("Enter an http or https URL containing %s. Searches use DuckDuckGo until then.")
          }
          control={
            <DraftInput
              nativeInput
              size="sm"
              className="w-full sm:w-64"
              aria-label={t("Custom search URL")}
              placeholder={"https://example.com/search?q=%s"}
              autoCapitalize="none"
              spellCheck={false}
              maxLength={BROWSER_CUSTOM_SEARCH_URL_MAX_LENGTH}
              value={customUrl}
              onCommit={(next) => updateSettings({ browserCustomSearchUrl: next.trim() })}
            />
          }
        />
      ) : null}
    </>
  );
}

export function PullRequestLinksOpenInAppSetting() {
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("pull-request-links-open-in-app")}
      description={t(
        "Clicking a pull request link opens it in T3.CodeShip. Turn off to open pull request links like any other link, on your git host.",
      )}
      resetAction={
        openInApp ? null : (
          <SettingResetButton
            label={t("open pull requests in T3.CodeShip")}
            onClick={() => updateSettings({ pullRequestLinksOpenInApp: true })}
          />
        )
      }
      control={
        <Switch
          checked={openInApp}
          onCheckedChange={(checked) =>
            updateSettings({ pullRequestLinksOpenInApp: Boolean(checked) })
          }
          aria-label={t("Open pull requests in T3.CodeShip")}
        />
      }
    />
  );
}

function DeviceIntegrationSettings() {
  const { search, environment: selected } = useSettingsScope();
  const settings = useScopedSettings();
  const connected = selected?.connection.phase === "connected" && selected.serverConfig !== null;
  const environmentId = connected ? selected.environmentId : null;

  const { state } = useDeviceState(environmentId);

  return (
    <>
      <SettingsSection id="devices" title={t("Devices")}>
        <DeviceIntegrationControls
          key={`${environmentId}:${JSON.stringify(search)}`}
          environmentId={environmentId}
          enabled={settings.enableDeviceSupport}
          agentAccessEnabled={settings.enableAgentDeviceAccess}
        />
      </SettingsSection>
      <DeviceSourcesSettings
        supportsEas={state.supportsEasHosts === true}
        supportsSimlock={state.supportsSimlockHosts === true}
      />
      <SettingsSection id="device-experiments" title={t("Experimental")}>
        <SimlockHostsRow />
      </SettingsSection>
    </>
  );
}

function DeviceIntegrationControls({
  environmentId,
  enabled,
  agentAccessEnabled,
}: {
  environmentId: EnvironmentId | null;
  enabled: boolean;
  agentAccessEnabled: boolean;
}) {
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { state, loaded } = useDeviceState(environmentId);
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const anyHubEnabled = connectedEnvironments.some(
    (environment) => environment.serverConfig?.settings.enableDeviceSupport,
  );
  const configure = useAtomCommand(deviceEnvironment.configure, { reportFailure: false });
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const [pending, setPending] = useState<
    "hub" | "check" | "agent" | "update-hub" | "update-agent" | null
  >(null);
  const { busy } = deviceHubReadiness(state);

  const update = async (
    kind: NonNullable<typeof pending>,
    input: { enabled?: boolean; agentAccessEnabled?: boolean },
  ) => {
    if (!environmentId || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    setPending(kind);
    const results = await Promise.allSettled(
      environments.map(async (environment) => {
        if (environment.connection.phase !== "connected" || !environment.serverConfig) {
          throw new Error("Environment disconnected");
        }
        if (!readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope)) {
          throw new Error("This connection cannot change device settings.");
        }
        return configure({
          environmentId: environment.environmentId,
          input: { ...input, ...(input.enabled ? { onboardingCompleted: true } : {}) },
        });
      }),
    );
    setPending(null);
    const failed = environments.filter((_, index) => {
      const result = results[index];
      return result?.status !== "fulfilled" || result.value._tag === "Failure";
    });
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title: t("Device settings not saved on all environments"),
        description: t("Could not update {environments}.", {
          environments: failed.map((environment) => environment.label).join(", "),
        }),
      });
    }
  };

  const [updateError, setUpdateError] = useState<{ tool: "hub" | "agent"; message: string } | null>(
    null,
  );
  const localTools = state.hosts.find((host) => host.kind === "local")?.tools;
  const versionActions = (tool: "hub" | "agent") => {
    const version = localTools?.[tool];
    const needsUpdate = version && !version.installedVersions.includes(version.requiredVersion);
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {state.supportsToolUpdate && needsUpdate ? (
            <Button
              size="sm"
              disabled={!environmentId || pending !== null || busy}
              onClick={() => {
                if (!environmentId) return;
                setUpdateError(null);
                setPending(`update-${tool}`);
                void list({ environmentId, input: { updateTool: tool } })
                  .then((result) => {
                    if (result._tag === "Failure")
                      setUpdateError({ tool, message: formatEnvironmentQueryError(result.cause) });
                  })
                  .finally(() => setPending(null));
              }}
            >
              {pending === `update-${tool}` ? t("Updating…") : t("Update")}
            </Button>
          ) : null}
          {state.supportsToolInspection ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!environmentId || pending !== null || busy}
              onClick={() => {
                if (!environmentId) return;
                setPending("check");
                void list({ environmentId, input: { inspectOnly: true } }).finally(() =>
                  setPending(null),
                );
              }}
            >
              {pending === "check" ? t("Checking…") : t("Check versions")}
            </Button>
          ) : null}
        </div>
        {updateError?.tool === tool ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {updateError.message}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("device-hub")}
        serverScoped
        settingKeys={["enableDeviceSupport"]}
        description={tx("Open simulators and emulators in the Device panel. Hub: {versions}", {
          versions: (
            <DeviceToolVersions
              action={versionActions("hub")}
              kind="hub"
              tools={state.hosts.find((host) => host.kind === "local")?.tools}
            />
          ),
        })}
        control={
          <>
            {pending === "hub" ? <DeviceHubSetupStatus state={state} pending compact /> : null}
            <ScopedSwitch
              settingKeys={["enableDeviceSupport"]}
              checked={enabled}
              disabled={
                !canConfigure ||
                projectScope ||
                !loaded ||
                !environmentId ||
                busy ||
                pending !== null
              }
              aria-label={t("Device hub")}
              onCheckedChange={(checked) =>
                void update("hub", {
                  enabled: Boolean(checked),
                  ...(checked ? {} : { agentAccessEnabled: false }),
                })
              }
            />
          </>
        }
      />
      <SettingsRow
        {...searchableSetting("agent-device-access")}
        serverScoped
        settingKeys={["enableAgentDeviceAccess"]}
        description={tx(
          "New agent sessions can open and drive these devices. agent-device: {versions}",
          {
            versions: (
              <DeviceToolVersions
                action={versionActions("agent")}
                kind="agent"
                tools={state.hosts.find((host) => host.kind === "local")?.tools}
              />
            ),
          },
        )}
        control={
          <>
            {pending === "agent" ? <AgentDeviceSetupStatus state={state} pending compact /> : null}
            <ScopedSwitch
              settingKeys={["enableAgentDeviceAccess"]}
              checked={agentAccessEnabled}
              disabled={
                !canConfigure ||
                connectedEnvironments.length === 0 ||
                (!projectScope && (!loaded || !anyHubEnabled || busy)) ||
                pending !== null
              }
              aria-label={t("Agent device access")}
              onCheckedChange={(checked) =>
                projectScope
                  ? updateSettings({ enableAgentDeviceAccess: Boolean(checked) })
                  : void update("agent", { agentAccessEnabled: Boolean(checked) })
              }
            />
          </>
        }
      />
      {environmentId ? (
        <DeviceHostUpdates
          state={{ ...state, hosts: state.hosts.filter((host) => host.kind === "local") }}
          environmentId={environmentId}
        />
      ) : null}
    </>
  );
}

function AgentBrowserAccessSetting() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentBrowserAccess"]}
      {...searchableSetting("agent-browser-access")}
      description={
        isProjectScope
          ? t(
              "Allow agents in this project to use the shared browser. Applies when the agent session next starts.",
            )
          : t("Allow agents to use the shared browser. Projects can override it.")
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label={t("default browser access")}
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentBrowserAccess"]}
          aria-label={t("Agent browser access")}
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
        />
      }
    />
  );
}

function BrowserAutoShowFloatingPreviewSetting() {
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-auto-show-floating-preview")}
      description={t(
        "Show the floating preview when an agent opens a browser or device unless the agent says otherwise.",
      )}
      resetAction={
        autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label={t("auto-show floating preview")}
            onClick={() =>
              updateSettings({
                browserAutoShowFloatingPreview: DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={autoShow}
          onCheckedChange={(checked) =>
            updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
          }
          aria-label={t("Auto-show floating preview")}
        />
      }
    />
  );
}

function BrowserProfilesSetting() {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  // Cookie import runs on this desktop, whose policy the primary environment reports.
  const cookieImportDenial = managedCapabilityDenial(
    usePrimaryManagedPolicy(),
    "browserCookieImport",
  );
  const [sources, setSources] = useState<ReadonlyArray<BrowserImportSource> | null>(null);
  const [importSession, setImportSession] = useState<{
    readonly source: BrowserImportSource;
    readonly environmentId: EnvironmentId;
    readonly environmentName: string;
  } | null>(null);
  const [profilePendingRemoval, setProfilePendingRemoval] = useState<BrowserProfile | null>(null);
  const [profilePendingClear, setProfilePendingClear] = useState<BrowserProfile | null>(null);
  const [profileRemovalError, setProfileRemovalError] = useState<string | null>(null);
  const [profileRemovalInFlight, setProfileRemovalInFlight] = useState(false);
  const serverConfigs = useServerConfigs();
  const runClearServerProfile = useAtomCommand(previewEnvironment.clearProfile, {
    reportFailure: false,
  });
  const serverProfileData: ServerProfileData = {
    environmentIds: environments
      .map((environment) => environment.environmentId)
      .filter(
        (environmentId) =>
          serverConfigs.get(environmentId)?.environment.capabilities.serverBrowser === true,
      ),
    clear: async (environmentId, profileId) => {
      const result = await runClearServerProfile({ environmentId, input: { profileId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    },
  };
  const removalAvailable = browserProfileRemovalAvailable(
    previewBridge !== null,
    environmentsReady,
    environments.length,
    serverProfileData.environmentIds.length,
  );
  const importInFlightRef = useRef(false);
  const [importInFlight, setImportInFlight] = useState(false);
  const profileWritesDisabled = !settingsHydrated;

  const profiles = resolveBrowserProfiles(userProfiles);
  const listedProfiles = profiles.filter((profile) => profile.kind !== "incognito");
  const resolvedDefaultId =
    findBrowserProfile(listedProfiles, defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID;

  const createProfile = (baseName: string) => {
    if (!settingsHydrated || importInFlightRef.current) return undefined;
    const currentProfiles = getClientSettings().browserProfiles;
    // Check live settings; repeated clicks before render can bypass the disabled control.
    if (currentProfiles.length >= BROWSER_PROFILE_MAX_COUNT) return undefined;
    const resolvedProfiles = resolveBrowserProfiles(currentProfiles);
    const taken = new Set(resolvedProfiles.map((profile) => profile.name));
    let name = baseName;
    for (let index = 2; taken.has(name); index += 1) name = `${baseName} ${index}`;
    const profile = { id: `profile-${randomUUID()}`, name, kind: "persistent" as const };
    updateSettings({ browserProfiles: [...currentProfiles, profile] });
    return profile;
  };

  const renameProfile = (id: string, next: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    const name = next.trim().slice(0, BROWSER_PROFILE_NAME_MAX_LENGTH);
    if (name === "") return;
    const currentProfiles = getClientSettings().browserProfiles;
    updateSettings({
      browserProfiles: currentProfiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile,
      ),
    });
  };

  const clearProfileData = (id: string, name: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!removalAvailable) {
      toastManager.add({
        type: "error",
        title: t("Could not clear {name}'s data", { name }),
        description: t("You're not connected to a server yet."),
      });
      return;
    }
    void clearBrowserProfileData(
      previewBridge,
      environments.map((environment) => environment.environmentId),
      id,
      serverProfileData,
    )
      .then(() => {
        toastManager.add({
          type: "success",
          title: t("Cleared {name}'s cookies and cache", { name }),
        });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: t("Could not clear {name}'s data", { name }) });
      });
  };

  const removeProfile = async (id: string) => {
    if (!settingsHydrated || importInFlightRef.current) return;
    if (!removalAvailable) {
      setProfileRemovalError(t("Connect to an environment before removing this profile."));
      return;
    }
    setProfileRemovalError(null);
    setProfileRemovalInFlight(true);
    try {
      await clearBrowserProfileData(
        previewBridge,
        environmentsReady ? environments.map((environment) => environment.environmentId) : [],
        id,
        serverProfileData,
      );
    } catch {
      setProfileRemovalError(t("Profile data could not be deleted. Try again."));
      setProfileRemovalInFlight(false);
      return;
    }
    const currentSettings = getClientSettings();
    updateSettings({
      browserProfiles: currentSettings.browserProfiles.filter((profile) => profile.id !== id),
      browserAssistants: currentSettings.browserAssistants.filter(
        (assistant) => assistant.profileId !== id,
      ),
      ...(currentSettings.browserDefaultProfileId === id
        ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
        : {}),
    });
    setProfileRemovalInFlight(false);
    setProfilePendingRemoval(null);
  };

  const importableSources = (sources ?? []).filter(
    (source) =>
      source.unavailable !== "notInstalled" && source.unavailable !== "unsupportedPlatform",
  );

  const loadSources = () => {
    if (!previewBridge) return;
    void previewBridge
      .listBrowserImportSources()
      .then(setSources)
      .catch(() => setSources((previous) => previous ?? []));
  };

  const runWizardImport = async (
    source: BrowserImportSource,
    environmentId: EnvironmentId,
    input: { readonly sourceProfileDirectory: string; readonly target: WizardTarget },
  ): Promise<ImportOutcome> => {
    if (!previewBridge) return { kind: "blocked", reason: "sessionUnavailable" };
    if (!settingsHydrated) return { kind: "blocked", reason: "sessionUnavailable" };
    if (
      input.target.kind === "existing" &&
      !resolveBrowserProfiles(getClientSettings().browserProfiles).some(
        (profile) => profile.id === input.target.profileId,
      )
    ) {
      return { kind: "blocked", reason: "readFailed" };
    }
    if (importInFlightRef.current) return { kind: "blocked", reason: "readFailed" };
    importInFlightRef.current = true;
    setImportInFlight(true);
    return importBrowserCookiesIntoTarget(previewBridge, source, environmentId, input).finally(
      () => {
        importInFlightRef.current = false;
        setImportInFlight(false);
      },
    );
  };

  const refreshImportSource = async (
    sourceId: BrowserImportSource["id"],
  ): Promise<BrowserImportSource | undefined> => {
    if (!previewBridge) return undefined;
    try {
      const latest = await previewBridge.listBrowserImportSources();
      setSources(latest);
      return latest.find((source) => source.id === sourceId);
    } catch {
      return undefined;
    }
  };

  const atProfileLimit = userProfiles.length >= BROWSER_PROFILE_MAX_COUNT;

  return (
    <SettingsRow
      {...searchableSetting("browser-profiles")}
      description={t(
        "Profiles separate cookies and logins. Incognito data is cleared when the app closes.",
      )}
      control={
        <Menu onOpenChange={(open) => open && loadSources()}>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                disabled={profileWritesDisabled || importInFlight}
              />
            }
          >
            <PlusIcon />
            {t("Add profile")}
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              disabled={!settingsHydrated || atProfileLimit}
              onClick={() => createProfile("New profile")}
            >
              {t("Blank profile")}
            </MenuItem>
            {atProfileLimit ? (
              <MenuItem disabled>{t("You’ve reached the profile limit")}</MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("Import from")}</MenuGroupLabel>
              {cookieImportDenial !== undefined ? (
                <MenuItem disabled>{cookieImportDenial}</MenuItem>
              ) : sources === null ? (
                <MenuItem disabled>{t("Looking for browsers…")}</MenuItem>
              ) : importableSources.length === 0 ? (
                <MenuItem disabled>{t("No supported browsers found")}</MenuItem>
              ) : (
                <>
                  {importableSources.map((source) => (
                    <MenuItem
                      key={source.id}
                      disabled={!settingsHydrated || primaryEnvironment == null}
                      onClick={() => {
                        if (!settingsHydrated || primaryEnvironment == null) return;
                        setImportSession({
                          source,
                          environmentId: primaryEnvironment.environmentId,
                          environmentName: resolveEnvironmentOptionLabel({
                            isPrimary: true,
                            environmentId: primaryEnvironment.environmentId,
                            runtimeLabel: primaryEnvironment.label,
                          }),
                        });
                      }}
                    >
                      {source.name}
                    </MenuItem>
                  ))}
                  {primaryEnvironment == null ? (
                    <MenuItem disabled>{t("Connect to an environment to import cookies")}</MenuItem>
                  ) : null}
                </>
              )}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      }
    >
      <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
        {listedProfiles.map((profile, index) => {
          const builtIn = isBuiltInBrowserProfileId(profile.id);
          const isDefault = profile.id === resolvedDefaultId;
          return (
            <div
              key={profile.id}
              className={cn(
                "flex items-center gap-3 px-3 py-2",
                index > 0 && "border-t border-border/60",
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {builtIn ? (
                  <span
                    className={cn(
                      "truncate text-sm text-foreground",
                      profileWritesDisabled && "opacity-64",
                    )}
                  >
                    {profile.name}
                  </span>
                ) : (
                  <DraftInput
                    nativeInput
                    size="sm"
                    className="w-full max-w-56"
                    aria-label={t("Rename {name}", { name: profile.name })}
                    disabled={profileWritesDisabled || importInFlight}
                    maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                    value={profile.name}
                    onCommit={(next) => renameProfile(profile.id, next)}
                  />
                )}
                {isDefault ? (
                  <span className={cn("flex", profileWritesDisabled && "opacity-64")}>
                    <Badge>{t("Default")}</Badge>
                  </span>
                ) : null}
              </span>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      disabled={profileWritesDisabled || importInFlight}
                      aria-label={t("{name} options", { name: profile.name })}
                    />
                  }
                >
                  <MoreVertical />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={!settingsHydrated || isDefault}
                    onClick={() => {
                      if (settingsHydrated) {
                        updateSettings({ browserDefaultProfileId: profile.id });
                      }
                    }}
                  >
                    {t("Set as default")}
                  </MenuItem>
                  <MenuItem
                    disabled={!settingsHydrated || !removalAvailable}
                    onClick={() => {
                      if (serverProfileData.environmentIds.length > 0) {
                        setProfilePendingClear(profile);
                      } else clearProfileData(profile.id, profile.name);
                    }}
                  >
                    {t("Clear cookies and cache")}
                  </MenuItem>
                  {builtIn ? null : (
                    <MenuItem
                      variant="destructive"
                      disabled={!settingsHydrated || !removalAvailable}
                      onClick={() => {
                        if (settingsHydrated) setProfilePendingRemoval(profile);
                      }}
                    >
                      {t("Remove profile and data")}
                    </MenuItem>
                  )}
                  {!removalAvailable ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled>
                        {environmentsReady
                          ? t("Connect to an environment to clear profile data")
                          : t("Checking environments…")}
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </div>
          );
        })}
      </div>
      <AlertDialog
        open={profilePendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !profileRemovalInFlight) {
            setProfilePendingRemoval(null);
            setProfileRemovalError(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Remove “{name}”?", { name: profilePendingRemoval?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Its cookies and logins are deleted. Desktop tabs already open in this profile stay open until you close them; server browser tabs close now.",
              )}
            </AlertDialogDescription>
            {profileRemovalError ? (
              <p aria-live="polite" className="text-sm text-destructive-foreground">
                {profileRemovalError}
              </p>
            ) : null}
            {!removalAvailable ? (
              <p className="text-sm text-muted-foreground">
                {t("Connect to an environment to remove this profile and its data.")}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={profileRemovalInFlight}
              render={<Button variant="outline" disabled={profileRemovalInFlight} />}
            >
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={profileRemovalInFlight || !settingsHydrated || !removalAvailable}
              onClick={() => {
                if (profilePendingRemoval && settingsHydrated && removalAvailable) {
                  void removeProfile(profilePendingRemoval.id);
                }
              }}
            >
              {profileRemovalInFlight ? t("Removing…") : t("Remove profile")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={profilePendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setProfilePendingClear(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Clear “{name}”’s cookies and cache?", {
                name: profilePendingClear?.name ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "You are signed out of its sites. Server browser tabs open in this profile close now.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (profilePendingClear)
                  clearProfileData(profilePendingClear.id, profilePendingClear.name);
                setProfilePendingClear(null);
              }}
            >
              {t("Clear data")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {importSession ? (
        <BrowserImportWizard
          source={importSession.source}
          destinationEnvironmentName={importSession.environmentName}
          targetProfiles={listedProfiles.map((profile) => ({ id: profile.id, name: profile.name }))}
          canCreateProfile={settingsHydrated && !atProfileLimit}
          onImport={(input) =>
            runWizardImport(importSession.source, importSession.environmentId, input)
          }
          onRefreshSource={() => refreshImportSource(importSession.source.id)}
          onCheckFullDiskAccess={
            window.desktopBridge
              ? () => window.desktopBridge!.checkSystemPermission("full-disk-access")
              : undefined
          }
          onOpenFullDiskAccessSettings={async () => {
            await readLocalApi()
              ?.shell.openSystemSettings("full-disk-access")
              .catch(() => {
                toastManager.add({
                  type: "error",
                  title: t("Could not open System Settings"),
                  description: t("Open Privacy & Security → Full Disk Access manually."),
                });
              });
          }}
          onClose={() => setImportSession(null)}
        />
      ) : null}
    </SettingsRow>
  );
}

function BrowserAssistantsSetting() {
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();
  const assistants = useBrowserAssistants();
  const profiles = useClientSettings((settings) =>
    resolveBrowserProfiles(settings.browserProfiles).filter(
      (profile) => profile.kind !== "incognito",
    ),
  );
  const writesDisabled = !settingsHydrated;
  const added = new Set(assistants.map(browserAssistantKey));

  // Read live settings so a second click before rerender cannot add a duplicate.
  const addAssistant = (kind: BrowserAssistantKind, profileId: string) => {
    if (!settingsHydrated) return;
    const current = getClientSettings().browserAssistants;
    const key = browserAssistantKey({ kind, profileId });
    if (current.some((entry) => browserAssistantKey(entry) === key)) return;
    updateSettings({ browserAssistants: [...current, { kind, profileId }] });
  };

  const removeAssistant = (key: string) => {
    if (!settingsHydrated) return;
    updateSettings({
      browserAssistants: getClientSettings().browserAssistants.filter(
        (entry) => browserAssistantKey(entry) !== key,
      ),
    });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-assistants")}
      description={t(
        "Open a ChatGPT dot or Claude Duet from the thread details card, in the browser profile signed in to that account.",
      )}
      control={
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" disabled={writesDisabled} />}>
            <PlusIcon />
            {t("Add")}
          </MenuTrigger>
          <MenuPopup align="end">
            {BrowserAssistantKindSchema.literals.map((kind) => {
              const { label, Icon } = BROWSER_ASSISTANTS[kind];
              return (
                <MenuSub key={kind}>
                  <MenuSubTrigger>
                    <Icon aria-hidden className="size-4" />
                    {label}
                  </MenuSubTrigger>
                  <MenuSubPopup className="max-w-56">
                    <MenuGroup>
                      <MenuGroupLabel>{t("Browser profile")}</MenuGroupLabel>
                      {profiles.map((profile) => (
                        <MenuItem
                          key={profile.id}
                          disabled={added.has(browserAssistantKey({ kind, profileId: profile.id }))}
                          onClick={() => addAssistant(kind, profile.id)}
                        >
                          <span className="min-w-0 truncate">{profile.name}</span>
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
          </MenuPopup>
        </Menu>
      }
    >
      {assistants.length > 0 ? (
        <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
          {assistants.map((assistant, index) => {
            const key = browserAssistantKey(assistant);
            const label = browserAssistantLabel(assistant);
            const { Icon } = BROWSER_ASSISTANTS[assistant.kind];
            return (
              <div
                key={key}
                className={cn(
                  "flex items-center gap-3 px-3 py-2",
                  index > 0 && "border-t border-border/60",
                )}
              >
                <Icon
                  aria-hidden
                  className={cn("size-4 shrink-0", writesDisabled && "opacity-64")}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sm text-foreground",
                    writesDisabled && "opacity-64",
                  )}
                >
                  {label}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={writesDisabled}
                  aria-label={t("Remove {name}", { name: label })}
                  onClick={() => removeAssistant(key)}
                >
                  <XIcon />
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function BrowserSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="browser-agent-access" title={t("Agent access")}>
        <AgentBrowserAccessSetting />
      </SettingsSection>
      <SettingsSection id="browser" title={t("Browsing")}>
        {/* The built-in browser runs in the desktop app; web clients only search from server-run tabs. */}
        {isElectron ? (
          <>
            <BrowserProfilesSetting />
            <BrowserAssistantsSetting />
            <BrowserLinkTargetSetting />
            <BrowserAutoShowFloatingPreviewSetting />
          </>
        ) : null}
        <BrowserSearchEngineSetting />
        {isElectron ? (
          <AdvancedSettings
            targetIds={[
              searchableSetting("browser-default-viewport").id,
              searchableSetting("browser-default-zoom").id,
              searchableSetting("browser-default-appearance").id,
            ]}
          >
            <BrowserViewportSetting />
            <BrowserZoomSetting />
            <BrowserAppearanceSetting />
          </AdvancedSettings>
        ) : null}
      </SettingsSection>
      {isElectron ? (
        <SettingsSection id="browser-recordings" title={t("Recordings")}>
          <BrowserRecordingFrameRateSetting />
          <BrowserRecordingInputSettings />
        </SettingsSection>
      ) : null}
      <DeviceIntegrationSettings />
    </SettingsPageContainer>
  );
}
