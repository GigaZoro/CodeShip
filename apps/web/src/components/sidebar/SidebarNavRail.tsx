import { useAtomValue } from "@effect/atom-react";
import {
  ActivityIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  GaugeIcon,
  HandIcon,
  LayoutGridIcon,
  PuzzleIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  SettingsIcon,
  ShapesIcon,
} from "lucide-react";
import { collectLimitPools, tightestLimitWindow } from "@t3tools/shared/usageLimits";
import { memo, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useUsageLimitNow } from "../../hooks/useUsageNow";
import { shortcutLabelForCommand } from "../../keybindings";
import { MachinesGlance } from "../machines/MachineResources";
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
  useLimitAccounts,
} from "../usage/UsageLimitsGlance";
import { isSettingsPage, isSidebarSectionPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { useScheduledTasksRailBadge } from "./useScheduledTasksRailBadge";
import { useSidebarMachines } from "./useSidebarMachines";
import {
  useExtensionsRailBadge,
  useManualStepsRailBadge,
  usePullRequestsRailBadge,
  useSettingsRailBadge,
  useThreadsRailBadge,
} from "./useSidebarNavRailBadges";

import { t } from "~/i18n";
type SidebarNavDestination =
  | "threads"
  | "projects"
  | "pull-requests"
  | "artifacts"
  | "extensions"
  | "scheduled-tasks"
  | "thread-page"
  | "manual-steps"
  | "machines"
  | "usage"
  | "monitoring"
  | "settings";

function resolveActiveDestination(pathname: string): SidebarNavDestination | null {
  if (pathname === "/projects") return "projects";
  if (pathname === "/pull-requests") return "pull-requests";
  if (pathname === "/artifacts") return "artifacts";
  if (pathname === "/extensions") return "extensions";
  if (pathname === "/usage") return "usage";
  if (pathname === "/monitoring") return "monitoring";
  if (pathname === "/machines") return "machines";
  if (pathname === "/scheduled-tasks") return "scheduled-tasks";
  if (pathname === "/thread-page") return "thread-page";
  if (pathname === "/manual-steps") return "manual-steps";
  if (isSettingsPage(pathname)) return "settings";
  // Section pages without a rail item (Archived) highlight nothing.
  return isSidebarSectionPage(pathname) ? null : "threads";
}

function SidebarNavRailItem({
  icon,
  label,
  tooltip = label,
  badge,
  isActive,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tooltip?: ReactNode;
  badge?: ReactNode;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <Tooltip>
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
      {badge}
    </SidebarMenuItem>
  );
}

function SidebarNavRailMonitoringItem({
  isActive,
  onClick,
}: {
  isActive: boolean;
  onClick: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "monitoring.open");
  return (
    <SidebarNavRailItem
      icon={<ActivityIcon />}
      label={t("Monitoring")}
      tooltip={shortcut ? t("Monitoring ({shortcut})", { shortcut }) : t("Monitoring")}
      isActive={isActive}
      onClick={onClick}
    />
  );
}

/** Rings the limit closest to running out; hover summarizes every provider, click opens Usage. */
export function SidebarNavRailUsageItem({
  isActive,
  onClick,
}: {
  isActive: boolean;
  onClick: () => void;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "usage.open");
  const accounts = useLimitAccounts();
  const now = useUsageLimitNow(undefined, false);
  const tightest = tightestLimitWindow(collectLimitPools(accounts, now), now);
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
      tooltip={<UsageLimitsGlance accounts={accounts} shortcut={shortcut} />}
      isActive={isActive}
      onClick={onClick}
    />
  );
}

/** Hover reads each machine's CPU, memory and disk; click opens Machines. */
function SidebarNavRailMachinesItem({
  isActive,
  onClick,
}: {
  isActive: boolean;
  onClick: () => void;
}) {
  const machines = useSidebarMachines();
  return (
    <SidebarNavRailItem
      icon={<GaugeIcon />}
      label={t("Machines")}
      tooltip={machines.length === 0 ? t("Machines") : <MachinesGlance machines={machines} />}
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
  const threads = useThreadsRailBadge();
  const pullRequests = usePullRequestsRailBadge();
  const scheduledTasks = useScheduledTasksRailBadge();
  const extensions = useExtensionsRailBadge();
  const manualSteps = useManualStepsRailBadge();
  const settings = useSettingsRailBadge();
  const go = (destination: () => unknown) => () => {
    if (isMobile) setOpenMobile(false);
    void destination();
  };

  return (
    <nav
      aria-label={t("Sections")}
      data-slot="sidebar-nav-rail"
      className="flex shrink-0 flex-col items-center justify-between border-r border-sidebar-border pt-2 pb-1"
      style={{ width: THREAD_SIDEBAR_NAV_RAIL_WIDTH }}
    >
      <SidebarMenu className="items-center">
        <SidebarNavRailItem
          icon={<MessagesSquareIcon />}
          label={threads.label}
          badge={threads.badge}
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
            label={pullRequests.label}
            badge={pullRequests.badge}
            isActive={active === "pull-requests"}
            onClick={go(() =>
              navigate({ to: "/pull-requests", search: readPullRequestListPreferences() }),
            )}
          />
        ) : null}
        <SidebarNavRailItem
          icon={<CalendarClockIcon />}
          label={scheduledTasks.label}
          badge={scheduledTasks.badge}
          isActive={active === "scheduled-tasks"}
          onClick={go(() => navigate({ to: "/scheduled-tasks" }))}
        />
        <SidebarNavRailItem
          icon={<PuzzleIcon />}
          label={extensions.label}
          badge={extensions.badge}
          isActive={active === "extensions"}
          onClick={go(() => navigate({ to: "/extensions" }))}
        />
        <SidebarNavRailItem
          icon={<ShapesIcon />}
          label={t("Artifacts")}
          isActive={active === "artifacts"}
          onClick={go(() => navigate({ to: "/artifacts" }))}
        />
        <SidebarNavRailItem
          icon={<HandIcon />}
          label={manualSteps.label}
          badge={manualSteps.badge}
          isActive={active === "manual-steps"}
          onClick={go(() => navigate({ to: "/manual-steps" }))}
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
        <SidebarNavRailMachinesItem
          isActive={active === "machines"}
          onClick={go(() => navigate({ to: "/machines" }))}
        />
        <SidebarNavRailMonitoringItem
          isActive={active === "monitoring"}
          onClick={go(() => navigate({ to: "/monitoring" }))}
        />
        <SidebarNavRailUsageItem
          isActive={active === "usage"}
          onClick={go(() => navigate({ to: "/usage" }))}
        />
        <SidebarNavRailItem
          icon={<SettingsIcon />}
          label={settings.label}
          badge={settings.badge}
          isActive={active === "settings"}
          onClick={go(() => navigate({ to: "/settings" }))}
        />
      </SidebarMenu>
    </nav>
  );
});
