import { msg, t, type Message } from "~/i18n";
import {
  type ApprovalKeybindingCommand,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

export const APPROVAL_SHORTCUT_DECISIONS = {
  "approval.approve": "accept",
  "approval.decline": "decline",
  "approval.alwaysAllow": "acceptForSession",
} as const satisfies Record<ApprovalKeybindingCommand, ProviderApprovalDecision>;

/** Approvals without their own options offer every default decision. */
export function approvalOffersDecision(
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
  decision: ProviderApprovalDecision,
): boolean {
  return (options ?? DEFAULT_APPROVAL_OPTIONS).some((option) => option.decision === decision);
}

interface ComposerPendingApprovalActionsProps {
  presentation?: "composer" | "inline";
  requestId: RuntimeRequestId;
  /** Keyboard shortcuts that answer this request, by decision. */
  shortcutLabels?: Partial<Record<ProviderApprovalDecision, string>> | undefined;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_LABELS = {
  cancel: msg("Cancel"),
  decline: msg("Decline"),
  acceptForSession: msg("Always allow this session"),
  accept: msg("Approve"),
} satisfies Partial<Record<ProviderApprovalDecision, Message>>;

const DEFAULT_APPROVAL_OPTIONS = (["cancel", "decline", "acceptForSession", "accept"] as const).map(
  (decision) => ({ decision, label: DEFAULT_APPROVAL_LABELS[decision] }),
);

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  shortcutLabels,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const optionLabel = (option: ProviderApprovalOption) => {
    const defaultLabel =
      options === DEFAULT_APPROVAL_OPTIONS
        ? DEFAULT_APPROVAL_LABELS[option.decision as keyof typeof DEFAULT_APPROVAL_LABELS]
        : undefined;
    return defaultLabel === undefined ? option.label : t(defaultLabel);
  };
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: disabled || isResponding || !canRespond,
          "aria-description": option.warning,
          onClick: () => {
            if (!disabled && !isResponding && canRespond) {
              void onRespondToApproval(requestId, option.decision);
            }
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className={presentation === "inline" ? "whitespace-normal" : "max-w-40 truncate"}>
              {optionLabel(option)}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              {...buttonProps}
              tone={option.decision === "accept" ? "default" : "muted"}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              {...buttonProps}
              size="xs"
              variant={option.decision === "accept" ? "default" : "outline"}
            >
              {content}
            </Button>
          );
        const shortcut = shortcutLabels?.[option.decision];
        return option.warning || shortcut ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">
              {option.warning ? <div>{option.warning}</div> : null}
              {shortcut ? (
                <div>{t("{text} ({shortcut})", { text: optionLabel(option), shortcut })}</div>
              ) : null}
            </TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={disabled || isResponding || !canRespond}
            render={
              presentation === "inline" ? (
                <InlineButton tone="muted" aria-label={t("More approval options")} />
              ) : (
                <Button size="icon-xs" variant="outline" aria-label={t("More approval options")} />
              )
            }
          >
            {presentation === "inline" ? t("More") : <EllipsisIcon />}
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding && canRespond)
                      void onRespondToApproval(requestId, option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">
                    {optionLabel(option)}
                  </span>
                  {shortcutLabels?.[option.decision] ? (
                    <MenuShortcut>{shortcutLabels[option.decision]}</MenuShortcut>
                  ) : null}
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
