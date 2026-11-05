import { useAtomValue } from "@effect/atom-react";
import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  LayoutGridIcon,
  PuzzleIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  SettingsIcon,
  ShapesIcon,
} from "lucide-react";
import { tightestLimitWindow } from "@t3tools/shared/usageLimits";
import { memo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { usePullRequestsSupported } from "../../state/environments";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { THREAD_SIDEBAR_NAV_RAIL_WIDTH } from "../threadSidebarWidth";
import { ProgressRing } from "../ui/progress-ring";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  limitPoolLabel,
  limitTone,
  limitWindowLabel,
  UsageLimitsGlance,
  useLimitPools,
} from "../usage/UsageLimitsGlance";
import { isSettingsPage, isSidebarSectionPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

import { t } from "~/i18n";
type SidebarNavDestination =
  | "threads"
  | "projects"
  | "pull-requests"
  | "artifacts"
  | "extensions"
  | "scheduled-tasks"
  | "thread-page"
  | "usage"
  | "settings";

function resolveActiveDestination(pathname: string): SidebarNavDestination | null {
  if (pathname === "/projects") return "projects";
  if (pathname === "/pull-requests") return "pull-requests";
  if (pathname === "/artifacts") return "artifacts";
  if (pathname === "/extensions") return "extensions";
  if (pathname === "/usage") return "usage";
  if (pathname === "/scheduled-tasks") return "scheduled-tasks";
  if (pathname === "/thread-page") return "thread-page";
  if (isSettingsPage(pathname)) return "settings";
  // Section pages without a rail item (Archived) highlight nothing.
  return isSidebarSectionPage(pathname) ? null : "threads";
}

function SidebarNavRailItem({
  icon,
  label,
  tooltip = label,
  onTooltipOpenChange,
  isActive,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tooltip?: ReactNode;
  onTooltipOpenChange?: (open: boolean) => void;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <Tooltip onOpenChange={onTooltipOpenChange}>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-current={isActive ? "page" : undefined}
              isActive={isActive}
              onClick={onClick}
              size="icon"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="right">{tooltip}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/** Rings the limit closest to running out; hover summarizes every provider, click opens Usage. */
function SidebarNavRailUsageItem({
  isActive,
  onClick,
}: {
  isActive: boolean;
  onClick: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "usage.open");
  // Reset countdowns read the clock when the summary opens instead of ticking.
  const [now, setNow] = useState(() => Date.now());
  const pools = useLimitPools(now);
  const tightest = tightestLimitWindow(pools);
  if (!tightest) {
    return (
      <SidebarNavRailItem
        icon={<ChartNoAxesColumnIcon />}
        label={t("Usage")}
        tooltip={shortcut ? t("Usage ({shortcut})", { shortcut }) : t("Usage")}
        isActive={isActive}
        onClick={onClick}
      />
    );
  }
  const { pool, window } = tightest;
  return (
    <SidebarNavRailItem
      icon={
        <ProgressRing
          value={window.usedPercent}
          tone={limitTone(window.remainingPercent)}
          className="size-4"
        />
      }
      label={t("Usage: {pool} {window} {percent}% left", {
        pool: limitPoolLabel(pool),
        window: limitWindowLabel(pool, window),
        percent: window.remainingPercent,
      })}
      tooltip={<UsageLimitsGlance pools={pools} now={now} shortcut={shortcut} />}
      onTooltipOpenChange={(open) => {
        if (open) setNow(Date.now());
      }}
      isActive={isActive}
      onClick={onClick}
    />
  );
}

/** The app's top-level places, beside the thread list. */
export const SidebarNavRail = memo(function SidebarNavRail() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useLocation({ select: (location) => resolveActiveDestination(location.pathname) });
  const pullRequestsSupported = usePullRequestsSupported();
  const go = (destination: () => unknown) => () => {
    if (isMobile) setOpenMobile(false);
    void destination();
  };

  return (
    <nav
      aria-label={t("Sections")}
      className="flex shrink-0 flex-col items-center justify-between border-r border-sidebar-border pt-2 pb-1"
      style={{ width: THREAD_SIDEBAR_NAV_RAIL_WIDTH }}
    >
      <SidebarMenu className="items-center">
        <SidebarNavRailItem
          icon={<MessagesSquareIcon />}
          label={t("Threads")}
          isActive={active === "threads"}
          onClick={go(navigateToMainApp)}
        />
        <SidebarNavRailItem
          icon={<LayoutGridIcon />}
          label={t("Projects")}
          isActive={active === "projects"}
          onClick={go(() => navigate({ to: "/projects" }))}
        />
        {pullRequestsSupported ? (
          <SidebarNavRailItem
            icon={<PullRequestGlyph.pullRequest />}
            label={t("Pull requests")}
            isActive={active === "pull-requests"}
            onClick={go(() =>
              navigate({ to: "/pull-requests", search: readPullRequestListPreferences() }),
            )}
          />
        ) : null}
        <SidebarNavRailItem
          icon={<CalendarClockIcon />}
          label={t("Scheduled tasks")}
          isActive={active === "scheduled-tasks"}
          onClick={go(() => navigate({ to: "/scheduled-tasks" }))}
        />
        <SidebarNavRailItem
          icon={<PuzzleIcon />}
          label={t("Extensions")}
          isActive={active === "extensions"}
          onClick={go(() => navigate({ to: "/extensions" }))}
        />
        <SidebarNavRailItem
          icon={<ShapesIcon />}
          label={t("Artifacts")}
          isActive={active === "artifacts"}
          onClick={go(() => navigate({ to: "/artifacts" }))}
        />
        {/* The browser cannot embed thread.page, so the page is desktop only. */}
        {isElectron ? (
          <SidebarNavRailItem
            icon={<NotebookPenIcon />}
            label={"ThreadPage"}
            isActive={active === "thread-page"}
            onClick={go(() => navigate({ to: "/thread-page" }))}
          />
        ) : null}
      </SidebarMenu>
      <SidebarMenu className="items-center">
        <SidebarUpdatePill />
        <SidebarNavRailUsageItem
          isActive={active === "usage"}
          onClick={go(() => navigate({ to: "/usage" }))}
        />
        <SidebarNavRailItem
          icon={<SettingsIcon />}
          label={t("Settings")}
          isActive={active === "settings"}
          onClick={go(() => navigate({ to: "/settings" }))}
        />
      </SidebarMenu>
    </nav>
  );
});
