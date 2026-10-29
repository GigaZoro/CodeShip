import { cn } from "../lib/utils";
import { CodeShipMark } from "./CodeShipMark";

export function CodeShipBrand({
  className,
  markClassName,
}: {
  readonly className?: string;
  readonly markClassName?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2 font-semibold tracking-tight",
        className,
      )}
      role="img"
      aria-label="CodeShip"
    >
      <CodeShipMark className={cn("size-5 shrink-0 text-primary", markClassName)} />
      <span className="truncate">CodeShip</span>
    </span>
  );
}
