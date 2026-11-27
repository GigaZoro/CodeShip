import { createPresenceTracker } from "@t3tools/client-runtime/state/needs-you-triage";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "t3code:needs-you:present-at";

function load(): number | null {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch (error) {
    console.warn("Could not read when the user was last present", error);
    return null;
  }
}

function save(presentAt: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(presentAt));
  } catch (error) {
    console.warn("Could not store when the user was last present", error);
  }
}

let tracker: ReturnType<typeof createPresenceTracker> | null = null;

/** One tracker per window, listening from the first subscriber on. */
function presence() {
  if (tracker) return tracker;
  const created = createPresenceTracker({ now: Date.now, load, save });
  const present = () => created.present();
  const onVisibility = () => {
    if (document.visibilityState === "visible") created.present();
    else created.left();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "focus"] as const) {
    window.addEventListener(type, present, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", () => created.left());
  created.present();
  tracker = created;
  return created;
}

/** When the user left, while the Needs you box should say what changed since; otherwise null. */
export function useAwaySince(): number | null {
  return useSyncExternalStore(
    (listener) => presence().subscribe(listener),
    () => presence().getAwaySince(),
    () => null,
  );
}

export function markCaughtUp() {
  presence().caughtUp();
}
