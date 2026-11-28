import { manualStepsFailureMessage } from "@t3tools/client-runtime/state/manualSteps";
import { TriangleAlertIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { t, tn } from "~/i18n";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RailCountBadge } from "./SidebarNavRailBadge";
import { railProblemCount, type RailProblem } from "./sidebarNavRailCounts";
import { useRailProblems } from "./useSidebarNavRailBadges";

const MAX_NAMES = 3;

function namesList(names: ReadonlyArray<string>) {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES
    ? t("{names} +{count}", { names: shown, count: names.length - MAX_NAMES })
    : shown;
}

function problemLabel(problem: RailProblem): string {
  switch (problem.kind) {
    case "providers":
      return tn(
        problem.providers.length,
        "Settings: {count} provider needs attention: {names}",
        "Settings: {count} providers need attention: {names}",
        {
          names: namesList(
            problem.providers.map(({ name, environmentLabel }) => `${name} (${environmentLabel})`),
          ),
        },
      );
    case "mcp":
      return tn(
        problem.summary.count,
        "Extensions: {count} MCP server needs sign-in or failed when last checked: {names}",
        "Extensions: {count} MCP servers need sign-in or failed when last checked: {names}",
        { names: namesList(problem.summary.names) },
      );
    case "manual-steps":
      return t("Manual steps: {reason}", { reason: manualStepsFailureMessage(problem.reason) });
    case "pull-requests": {
      const { failingChecks, conflicts } = problem.pullRequests;
      const parts = [
        failingChecks > 0 && tn(failingChecks, "{count} failing check", "{count} failing checks"),
        conflicts > 0 && tn(conflicts, "{count} conflict", "{count} conflicts"),
      ].filter((part) => part !== false);
      return t("Pull requests: {parts}", { parts: parts.join(", ") });
    }
    case "scheduled-tasks":
      return tn(
        problem.failed,
        "Scheduled tasks: {count} task's last run failed",
        "Scheduled tasks: {count} tasks' last runs failed",
      );
  }
}

/** Every failure the rail knows of, behind one item that shows only while something failed. */
export function SidebarNavRailProblemsItem({
  go,
}: {
  go: (destination: () => unknown) => () => void;
}) {
  const navigate = useNavigate();
  const problems = useRailProblems();
  if (problems.length === 0) return null;
  const count = railProblemCount(problems);
  const label = tn(count, "{count} problem needs attention", "{count} problems need attention");
  const open = (problem: RailProblem) => {
    switch (problem.kind) {
      case "providers":
        return go(() => navigate({ to: "/settings/providers" }));
      case "mcp":
        return go(() => navigate({ to: "/extensions", search: { tab: "mcp" } }));
      case "manual-steps":
        return go(() => navigate({ to: "/manual-steps" }));
      case "pull-requests":
        return go(() =>
          navigate({ to: "/pull-requests", search: readPullRequestListPreferences() }),
        );
      case "scheduled-tasks":
        return go(() => navigate({ to: "/scheduled-tasks" }));
    }
  };
  return (
    <SidebarMenuItem>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <SidebarMenuButton data-ui-usage="problems" aria-label={label} size="icon" />
                }
              />
            }
          >
            <TriangleAlertIcon />
          </TooltipTrigger>
          <TooltipPopup side="right">{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup side="right" align="end">
          <MenuGroup>
            <MenuGroupLabel>{t("Problems")}</MenuGroupLabel>
            {problems.map((problem) => (
              <MenuItem key={problem.kind} onClick={open(problem)}>
                {problemLabel(problem)}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      <RailCountBadge count={count} source="problems" />
    </SidebarMenuItem>
  );
}
