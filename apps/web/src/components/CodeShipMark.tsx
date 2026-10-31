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
        d="M14 3v6l-6 6l6 3v4l-12 -6zM18 3l12 13l-12 6v-4l6 -3l-6 -6zM3 25h26l-4 4h-18z"
        fill="currentColor"
      />
    </svg>
  );
}
