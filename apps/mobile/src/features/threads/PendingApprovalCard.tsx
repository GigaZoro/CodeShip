import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { msg, t } from "../../lib/i18n";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  /** Offered when the request can no longer be answered. */
  readonly onStopThread?: (() => void) | undefined;
}

const APPROVAL_TITLES = {
  command: msg("Command approval"),
  "file-change": msg("File change approval"),
  "file-read": msg("File read approval"),
  permission: msg("App permission approval"),
  "mcp-elicitation": msg("App access approval"),
} as const satisfies Record<ProviderRequestKind, string>;

// Commands and paths read as code; app prompts read as prose.
const MONOSPACE_DETAIL_KINDS: ReadonlySet<ProviderRequestKind> = new Set([
  "command",
  "file-change",
  "file-read",
]);

const COLLAPSED_DETAIL_LINES = 6;
// Long single-line commands wrap, so length counts as well as line breaks.
const COLLAPSED_DETAIL_CHARACTERS = 360;

const defaultApprovalOptions = (): ReadonlyArray<ProviderApprovalOption> => [
  { decision: "accept", label: t("Allow once") },
  { decision: "acceptForSession", label: t("Allow session") },
  { decision: "decline", label: t("Decline") },
];

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? defaultApprovalOptions();
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  // Several long labels reflow unpredictably in a wrapping row, so they stack at full width.
  const stacked = options.length > 2;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const detail = props.approval.detail;
  const detailCollapsible =
    detail !== undefined &&
    (detail.split("\n").length > COLLAPSED_DETAIL_LINES ||
      detail.length > COLLAPSED_DETAIL_CHARACTERS);
  const monospaceDetail = MONOSPACE_DETAIL_KINDS.has(props.approval.requestKind);
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {t("Approval needed")}
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {t(APPROVAL_TITLES[props.approval.requestKind])}
      </Text>
      {props.approval.appName ? (
        <Text className="font-sans text-sm text-foreground-muted">{props.approval.appName}</Text>
      ) : null}
      {detail ? (
        <View className="gap-1">
          <Text
            selectable
            numberOfLines={
              detailCollapsible && !detailExpanded ? COLLAPSED_DETAIL_LINES : undefined
            }
            className={
              monospaceDetail
                ? "rounded-xl bg-subtle px-3 py-2 font-mono text-xs leading-5 text-foreground"
                : "font-sans text-sm leading-normal text-foreground-secondary"
            }
          >
            {detail}
          </Text>
          {detailCollapsible ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: detailExpanded }}
              className="min-h-11 justify-center self-start"
              hitSlop={4}
              onPress={() => setDetailExpanded((expanded) => !expanded)}
            >
              <Text className="font-t3-bold text-xs text-foreground-secondary underline">
                {detailExpanded ? t("Show less") : t("Show more")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {props.approval.reason ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">
          {props.approval.reason}
        </Text>
      ) : null}
      {props.approval.fullAccessOverride ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: explanationOpen }}
          className="min-h-11 justify-center"
          onPress={() => setExplanationOpen((open) => !open)}
        >
          <Text className="font-t3-bold text-xs text-foreground-secondary underline">
            {t(FULL_ACCESS_OVERRIDE_QUESTION)}
          </Text>
          {explanationOpen ? (
            <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
              {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {t("The agent's process has ended, so this request can't be answered.")}
        </Text>
      ) : null}
      {!canRespond && props.onStopThread ? (
        <Button
          label={t("Stop agent")}
          tone="danger"
          disabled={!props.canOperateThread}
          onPress={props.onStopThread}
        />
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
      <View className={stacked ? "gap-2.5" : "flex-row flex-wrap gap-2.5"}>
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            fullWidth={stacked}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          />
        ))}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          {t("This connection cannot respond to approvals.")}
        </Text>
      ) : null}
    </View>
  );
}
