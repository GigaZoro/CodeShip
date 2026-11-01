import {
  browserAssistantKey,
  type ResolvedBrowserAssistant,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, SettingsIcon, SparklesIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  BROWSER_ASSISTANTS,
  browserAssistantLabel,
  useOpenBrowserAssistant,
} from "~/browser/browserAssistants";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadAssistantsControl(props: {
  readonly threadRef: ScopedThreadRef;
  readonly assistants: ReadonlyArray<ResolvedBrowserAssistant>;
}) {
  const navigate = useNavigate();
  const openAssistant = useOpenBrowserAssistant(props.threadRef);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const only = props.assistants.length === 1 ? props.assistants[0] : undefined;
  const PrimaryIcon = only ? BROWSER_ASSISTANTS[only.kind].Icon : SparklesIcon;
  const primaryLabel = only ? browserAssistantLabel(only) : "Dots and Duets";

  return (
    <div
      role="group"
      aria-label="Dots and Duets"
      className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}
      ref={anchorRef}
    >
      <ThreadDetailsControl
        size="sm"
        variant="ghost"
        part="primary"
        aria-label={only ? `Open ${primaryLabel}` : "Choose a dot or Duet"}
        onClick={() => (only ? void openAssistant(only) : setMenuOpen(true))}
      >
        <PrimaryIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={cn("min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {primaryLabel}
        </span>
      </ThreadDetailsControl>
      <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="secondary"
              aria-label="Dots and Duets options"
            />
          }
        >
          <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end" anchor={anchorRef} className="w-(--anchor-width)">
          {props.assistants.map((assistant) => {
            const { Icon } = BROWSER_ASSISTANTS[assistant.kind];
            return (
              <MenuItem
                key={browserAssistantKey(assistant)}
                onClick={() => void openAssistant(assistant)}
              >
                <Icon aria-hidden className="size-4" />
                <MenuItemLabel>{browserAssistantLabel(assistant)}</MenuItemLabel>
              </MenuItem>
            );
          })}
          <MenuSeparator />
          <MenuItem onClick={() => void navigate({ to: "/settings/browser" })}>
            <SettingsIcon className="size-4" />
            <MenuItemLabel>Manage dots and Duets</MenuItemLabel>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
