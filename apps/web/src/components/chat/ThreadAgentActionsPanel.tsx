import { useNavigate } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { availableAgentActions } from "./agentActions";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import { t } from "~/i18n";

/** One-click requests sent to the agent in this thread, for work the user would otherwise type. */
export function ThreadAgentActionsPanel(props: {
  readonly isGitRepo: boolean;
  /** False when git shows no changes to commit or review; null when unknown. */
  readonly hasChanges: boolean | null;
  /** Why the agent cannot take a message now, or null when it can. */
  readonly unavailableReason: string | null;
  readonly onAsk: (prompt: string) => void;
}) {
  const navigate = useNavigate();
  const customActions = useClientSettings((settings) => settings.customAgentActions);
  return (
    <ThreadDetailsSection
      headingId="thread-details-agent-actions-heading"
      title={t("Ask the agent")}
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label={t("Edit your requests")}
                onClick={() =>
                  void navigate({
                    to: "/settings/appearance",
                    hash: "agent-actions",
                    hashScrollIntoView: false,
                  })
                }
              >
                <Settings2Icon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>{t("Edit your requests")}</TooltipPopup>
        </Tooltip>
      }
    >
      <div className="flex flex-col">
        {availableAgentActions(props.isGitRepo, customActions, props.hasChanges).map((action) => (
          <Tooltip key={action.id}>
            <TooltipTrigger
              delay={400}
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="row"
                  // Disabled buttons drop pointer events, so the tooltip keeps explaining why.
                  aria-disabled={props.unavailableReason !== null}
                  onClick={() => {
                    if (props.unavailableReason === null) props.onAsk(action.prompt);
                  }}
                />
              }
            >
              <action.icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>{action.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="left" className="max-w-72">
              {props.unavailableReason ?? t("Sends: “{preview}”", { preview: action.preview })}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
