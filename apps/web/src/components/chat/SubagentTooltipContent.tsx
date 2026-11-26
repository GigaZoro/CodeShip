import { t } from "~/i18n";
import {
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItemStatus,
  type OrchestrationProjectShell,
  type ServerProvider,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type OrchestrationV2Subagent,
  isOrchestrationV2WorkActive,
  REASONING_EFFORT_OPTION_IDS,
} from "@t3tools/contracts";
import {
  resolveSubagentMetadata,
  subagentDetailPreview,
} from "@t3tools/client-runtime/state/subagent-display";
import { getModelSelectionStringOptionValue, resolveSelectableModel } from "@t3tools/shared/model";
import { getTraitsSpeedDisplay, TraitsSpeedIcon } from "./TraitsSpeed";

import type { ReactNode } from "react";
import {
  BotIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderIcon,
  GitBranchIcon,
  TerminalIcon,
} from "lucide-react";
import { ThreadHoverCard } from "../ThreadHoverCard";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "../../providerInstances";

type SubagentSelectionInput = Pick<
  Parameters<typeof SubagentTooltipContent>[0],
  "model" | "providerInstanceId" | "origin" | "modelSelection" | "provider" | "childThread"
>;

/** The child's saved model selection when it still names the model the subagent reports. */
export function resolveSubagentSelection(props: SubagentSelectionInput) {
  const childSelection =
    props.modelSelection ??
    (props.origin === "app_owned" ? props.childThread?.modelSelection : undefined);
  const { modelSlug } = resolveSubagentMetadata({ ...props, modelSelection: childSelection });
  const childModel = props.provider
    ? (resolveSelectableModel(
        props.provider.driver,
        childSelection?.model,
        props.provider.models,
      ) ?? childSelection?.model.trim())
    : childSelection?.model.trim();
  const matchingSelection =
    childModel === modelSlug && childSelection?.instanceId === props.providerInstanceId
      ? childSelection
      : undefined;
  const effort = REASONING_EFFORT_OPTION_IDS.map((id) =>
    getModelSelectionStringOptionValue(matchingSelection, id),
  ).find(Boolean);
  return { childSelection, modelSlug, matchingSelection, effort };
}

/** Model, then what the subagent is doing now or how it ended, under its title. */
export function SubagentRowDetail(props: {
  readonly id?: string | undefined;
  readonly model: string | null;
  readonly effort: string | null | undefined;
  readonly provider: ServerProvider | undefined;
  readonly status: OrchestrationV2Subagent["status"];
  readonly progress?: string | null | undefined;
  /** The status in words, for when the work has ended or reports no progress. */
  readonly outcome: string;
  readonly machineLabel?: string | undefined;
}) {
  const { modelLabel } = resolveSubagentMetadata({ model: props.model, provider: props.provider });
  const progress = isOrchestrationV2WorkActive(props.status)
    ? props.progress?.slice(0, 240).replace(/\s+/gu, " ").trim()
    : undefined;
  const metadata = [
    props.effort ? `${modelLabel} · ${props.effort}` : modelLabel,
    ...(props.machineLabel === undefined ? [] : [t("on {label}", { label: props.machineLabel })]),
    progress,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  // Progress is the newest news and may be cut; the short status otherwise always shows.
  const outcome = progress ? "" : props.outcome;
  return (
    <span
      id={props.id}
      className={cn(
        "flex min-w-0 text-left text-2xs font-normal leading-4",
        props.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
      )}
    >
      {metadata === "" ? null : <span className="min-w-0 truncate">{metadata}</span>}
      {outcome === "" ? null : (
        <span className="shrink-0 whitespace-pre">
          {metadata === "" ? outcome : ` · ${outcome}`}
        </span>
      )}
    </span>
  );
}

export function SubagentTooltipContent(props: {
  title: string;
  model: string | null;
  providerInstanceId: ProviderInstanceId;
  origin: OrchestrationV2Subagent["origin"];
  modelSelection?: OrchestrationV2Subagent["modelSelection"];
  provider?: ServerProvider | undefined;
  providers?: ReadonlyArray<ServerProvider> | undefined;
  driver?: ProviderDriverKind | undefined;
  elapsed?: ReactNode;
  parentThread?: Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath"> | undefined;
  childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath" | "modelSelection">
    | undefined;
  parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | undefined;
  childProject?: Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot"> | undefined;
  status: OrchestrationV2TurnItemStatus;
  result?: string | null | undefined;
  progress?: string | null | undefined;
}) {
  const { childSelection, modelSlug, matchingSelection, effort } = resolveSubagentSelection(props);
  const { modelLabel, workspace: metadata } = resolveSubagentMetadata(
    {
      ...props,
      modelSelection: childSelection,
    },
    t,
  );
  const hasProjectRow =
    props.parentThread !== undefined &&
    props.childProject !== undefined &&
    props.childProject.id !== props.parentThread.projectId;
  const preview = subagentDetailPreview(props);
  const providerModel = props.provider?.models.find((candidate) => candidate.slug === modelSlug);
  const provider = props.provider;
  const speed = provider
    ? providerModel?.capabilities?.optionDescriptors
        ?.map((descriptor) => {
          const saved = matchingSelection?.options?.find((option) => option.id === descriptor.id);
          if (
            descriptor.id === "fastMode" &&
            descriptor.type === "boolean" &&
            typeof saved?.value === "boolean"
          ) {
            return getTraitsSpeedDisplay(
              {
                ...descriptor,
                currentValue: saved.value,
              },
              t,
            );
          }
          if (
            descriptor.id === "serviceTier" &&
            descriptor.type === "select" &&
            typeof saved?.value === "string" &&
            descriptor.options.some((option) => option.id === saved.value)
          ) {
            return getTraitsSpeedDisplay(
              {
                ...descriptor,
                currentValue: saved.value,
              },
              t,
            );
          }
          return null;
        })
        .find(Boolean)
    : undefined;
  const driver = props.provider?.driver ?? props.driver;
  const entries = deriveProviderInstanceEntries(props.providers ?? []);
  const entry = entries.find((candidate) => candidate.instanceId === props.provider?.instanceId);
  const showInstanceBadge = entry !== undefined && shouldShowInstanceBadge(entry, entries);
  const working = ["running", "in_progress", "pending", "waiting"].includes(props.status);
  const failed = ["failed", "error"].includes(props.status);
  const StatusIcon = working
    ? CircleDashedIcon
    : failed
      ? CircleXIcon
      : props.status === "completed"
        ? CheckIcon
        : CircleDashedIcon;
  return (
    <ThreadHoverCard title={props.title}>
      <div className="flex min-w-0 items-center gap-2">
        {driver ? (
          <ProviderInstanceIcon
            driverKind={driver}
            displayName={entry?.displayName ?? props.provider?.displayName ?? driver}
            accentColor={entry?.accentColor}
            acpRegistryIconUrl={props.provider?.iconUrl}
            showBadge={showInstanceBadge && entry?.accentColor !== undefined}
            badgeContent="none"
            badgeClassName="h-2 min-w-2 px-0"
            iconClassName="size-3 shrink-0 opacity-60"
          />
        ) : (
          <BotIcon className="size-3 shrink-0" />
        )}
        <span className="inline-flex min-w-0 items-center gap-1 text-foreground/75">
          <span className="min-w-0 truncate">
            {showInstanceBadge ? `${modelLabel} · ${entry.displayName}` : modelLabel}
          </span>
          {effort || speed?.speedIcon ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              {effort ? " · " : null}
              {speed?.speedIcon && provider ? (
                <TraitsSpeedIcon provider={provider.driver} speedIcon={speed.speedIcon} size="xs" />
              ) : null}
              {effort}
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-sm font-medium capitalize",
            working
              ? "text-info"
              : failed
                ? "text-error-foreground"
                : props.status === "completed"
                  ? "text-success"
                  : "text-muted-foreground",
          )}
        >
          <StatusIcon aria-hidden className="size-3 shrink-0" />
          {props.status === "idle"
            ? t("idle")
            : props.status === "pending"
              ? t("pending")
              : props.status === "running"
                ? t("running")
                : props.status === "waiting"
                  ? t("waiting")
                  : props.status === "completed"
                    ? t("completed")
                    : props.status === "failed"
                      ? t("failed")
                      : props.status === "cancelled"
                        ? t("cancelled")
                        : props.status === "interrupted"
                          ? t("interrupted")
                          : (props.status as string).replaceAll("_", " ")}
        </span>
        {props.elapsed}
      </div>
      {metadata.map(({ label, value }, index) => {
        const Icon =
          props.childThread?.branch && !(hasProjectRow && index === 0) ? GitBranchIcon : FolderIcon;
        return (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{label}</span>
            <MiddleTruncate value={value} className="flex" showTitle={false} />
          </div>
        );
      })}
      {preview ? (
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={preview} className="flex" showTitle={false} />
        </div>
      ) : null}
    </ThreadHoverCard>
  );
}
