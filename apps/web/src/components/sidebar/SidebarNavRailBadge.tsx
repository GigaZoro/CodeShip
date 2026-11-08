import { Badge } from "../ui/badge";

export type RailBadgeTone = "attention" | "problem" | "neutral";

const TONE_VARIANT = {
  attention: "attention",
  problem: "destructive",
  // Secondary matches the sidebar's own background.
  neutral: "outline",
} as const;

/** Sits beside the rail button, which clips its children. */
export function RailCountBadge({ count, tone }: { count: number; tone: RailBadgeTone }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute -top-1 -right-1">
      <Badge variant={TONE_VARIANT[tone]} size="sm">
        {count > 99 ? "99+" : count}
      </Badge>
    </span>
  );
}

export function RailDotBadge() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-destructive ring-2 ring-sidebar"
    />
  );
}
