import { Link } from "@tanstack/react-router";
import { memo } from "react";

import { useThreadIncidents } from "../../state/threadIncidents";
import {
  presentThreadIncident,
  useThreadIncidentNames,
} from "../incidents/threadIncidentPresentation";
import { t } from "~/i18n";

/**
 * One row per shared cause (a machine offline, a provider down, a usage limit), so the thread
 * list does not repeat it on every affected row. Each row opens where the cause can be handled.
 */
export const SidebarIncidents = memo(function SidebarIncidents() {
  const { incidents } = useThreadIncidents();
  const names = useThreadIncidentNames();
  if (incidents.length === 0) return null;
  return (
    <ul aria-label={t("Incidents")} className="flex flex-col">
      {incidents.map((incident) => {
        const view = presentThreadIncident(incident.cause, incident.threadKeys.length, names);
        const Icon = view.icon;
        return (
          <li key={incident.cause.key}>
            <Link
              to={view.to}
              title={view.actionLabel}
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-xs text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Icon
                aria-hidden
                className={
                  incident.cause.kind === "provider-outage"
                    ? "size-3.5 shrink-0 text-destructive-foreground"
                    : "size-3.5 shrink-0 text-warning-foreground"
                }
              />
              <span className="min-w-0 flex-1 truncate">{view.summary}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
});
