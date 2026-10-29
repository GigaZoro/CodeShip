import type { SVGProps } from "react";

export function CodeShipMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden
      focusable="false"
      {...props}
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10 7 1 16l9 9 2-3-6-6 6-6Zm12 0-2 3 6 6-6 6 2 3 9-9ZM19 4h-3l-4 24h3Z"
        fill="currentColor"
      />
    </svg>
  );
}
