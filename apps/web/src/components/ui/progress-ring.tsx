import { cn } from "~/lib/utils";

const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const toneClassName = {
  default: "stroke-current/72",
  warning: "stroke-warning",
  error: "stroke-error",
} as const;

export type ProgressRingTone = keyof typeof toneClassName;

/** Fills clockwise from 12 o'clock in the current text color. The caller sizes it. */
function ProgressRing({
  value,
  tone = "default",
  className,
}: {
  readonly value: number;
  readonly tone?: ProgressRingTone;
  readonly className?: string;
}) {
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-slot="progress-ring"
      className={cn("-rotate-90 transform-gpu", className)}
    >
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        strokeWidth="3"
        className="stroke-current/24"
      />
      {/* A round cap on an empty dash still paints a dot. */}
      {percent > 0 ? (
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - percent / 100)}
          className={cn(
            "transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none",
            toneClassName[tone],
          )}
        />
      ) : null}
    </svg>
  );
}

export { ProgressRing };
