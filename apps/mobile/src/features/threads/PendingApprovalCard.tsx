import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import {
  approvalTextParts,
  type ApprovalTextPart,
  FULL_ACCESS_OVERRIDE_QUESTION,
  PUSH_HOOKS_APPROVAL_QUESTION,
  pushHooksApprovalRows,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { msg, t, tn } from "../../lib/i18n";

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

export const defaultApprovalOptions = (): ReadonlyArray<ProviderApprovalOption> => [
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
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const { detail: rawDetail, pushHooks } = props.approval;
  const detail = !pushHooks && rawDetail ? approvalTextParts(rawDetail) : null;
  const detailCollapsible =
    detail !== null &&
    rawDetail !== undefined &&
    (rawDetail.split("\n").length > COLLAPSED_DETAIL_LINES ||
      rawDetail.length > COLLAPSED_DETAIL_CHARACTERS);
  const monospaceDetail = MONOSPACE_DETAIL_KINDS.has(props.approval.requestKind);
  return (
    <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {t("Approval needed")}
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {pushHooks
          ? t(PUSH_HOOKS_APPROVAL_QUESTION)
          : t(APPROVAL_TITLES[props.approval.requestKind])}
      </Text>
      {props.approval.appName ? (
        <Text className="font-sans text-sm text-foreground-muted">{props.approval.appName}</Text>
      ) : null}
      {pushHooks ? (
        <View className="gap-1.5">
          {pushHooksApprovalRows(pushHooks).map((row, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- rows never reorder and two hooks may read alike
            <View key={index} className="gap-0.5">
              <Text className="font-sans text-xs text-foreground-muted">{row.label}</Text>
              <Text selectable className="font-sans text-sm leading-normal text-foreground">
                {row.name ? `${row.name}  ` : null}
                <Text className="font-mono text-sm text-foreground">
                  {approvalTextParts(row.code)
                    .parts.map((part) => part.text)
                    .join("")}
                </Text>
              </Text>
            </View>
          ))}
        </View>
      ) : detail && detail.hiddenLength > 0 ? (
        <>
          <ApprovalTextScroll parts={detail.parts} />
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {tn(
              detail.hiddenLength,
              "… {count} character in the middle is not shown. The text ends with:",
              "… {count} characters in the middle are not shown. The text ends with:",
            )}
          </Text>
          <ApprovalTextScroll parts={detail.tail} fromEnd />
        </>
      ) : detail ? (
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
            <ApprovalTextParts parts={detail.parts} />
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
          {t(
            "The provider process for this request is no longer available. Interrupt or restart the run to continue.",
          )}
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
      <View className="gap-2">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
            fullWidth
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

/**
 * One end of text too long to show in full, in a box that scrolls on its own, so the note, the
 * other end and the buttons stay within reach. The end opens on its last line.
 */
function ApprovalTextScroll(props: {
  readonly parts: ReadonlyArray<ApprovalTextPart>;
  readonly fromEnd?: boolean;
}) {
  const box = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView
      ref={box}
      className="max-h-40"
      nestedScrollEnabled
      onContentSizeChange={
        props.fromEnd ? () => box.current?.scrollToEnd({ animated: false }) : undefined
      }
    >
      <Text selectable className="font-sans text-sm leading-normal text-foreground-secondary">
        <ApprovalTextParts parts={props.parts} />
      </Text>
    </ScrollView>
  );
}

function ApprovalTextParts(props: { readonly parts: ReadonlyArray<ApprovalTextPart> }) {
  return (
    <>
      {props.parts.map((part, index) =>
        part.named ? (
          // Tinted only: a second font inside wrapped lines makes Android lay the text out shorter
          // than it draws, which cuts off its last lines.
          // oxlint-disable-next-line react/no-array-index-key -- parts never reorder and two may read alike
          <Text key={index} className="text-warning-foreground">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
