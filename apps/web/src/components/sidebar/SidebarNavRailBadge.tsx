import { Badge } from "../ui/badge";
import type { RailBadgeSource } from "./sidebarNavRailCounts";

const TONE_VARIANT = {
  "needs-you": "attention",
  problems: "destructive",
} as const satisfies Record<RailBadgeSource, string>;

/** Sits beside the rail button, which clips its children. */
export function RailCountBadge({ count, source }: { count: number; source: RailBadgeSource }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute -top-1 -right-1">
      <Badge variant={TONE_VARIANT[source]} size="sm">
        {count > 99 ? "99+" : count}
      </Badge>
    </span>
  );
}
