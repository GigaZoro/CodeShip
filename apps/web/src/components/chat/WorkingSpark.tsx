import { observeVisibleAnimation } from "~/lib/visibleAnimation";

const FRAME_COUNT = 6;
const RAY_COUNT = 8;

// Frames stack vertically, one per 16-unit cell: a dot that blooms into a spark as it turns
// upright. The `working-spark` utility steps through them by translating the strip.
function framePath(frame: number) {
  const bloom = 1 - (1 - frame / (FRAME_COUNT - 1)) ** 2;
  const centerY = 8 + frame * 16;
  const turn = ((bloom - 1) * Math.PI) / 4;
  let path = "";
  for (let ray = 0; ray < RAY_COUNT; ray++) {
    const length = bloom * (ray % 2 === 0 ? 6 : 3.5);
    const angle = turn + (ray * 2 * Math.PI) / RAY_COUNT;
    const dx = (Math.sin(angle) * length).toFixed(2);
    const dy = (-Math.cos(angle) * length).toFixed(2);
    path += `M8 ${centerY}l${dx} ${dy}`;
  }
  return path;
}

const sparkPath = Array.from({ length: FRAME_COUNT }, (_, frame) => framePath(frame)).join("");

export function WorkingSpark() {
  return (
    <span
      aria-hidden
      ref={observeVisibleAnimation}
      className="block size-4 shrink-0 overflow-hidden text-primary"
    >
      <svg
        viewBox={`0 0 16 ${FRAME_COUNT * 16}`}
        className="working-spark block h-[600%] w-full"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      >
        <path d={sparkPath} />
      </svg>
    </span>
  );
}
