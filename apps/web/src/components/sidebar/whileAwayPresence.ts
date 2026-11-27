import {
  type AwayWindow,
  createPresenceTracker,
} from "@t3tools/client-runtime/state/needs-you-triage";
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
  // Pointer up, not down: the strip may mount on return, and must not move what is being clicked.
  for (const type of ["pointerup", "keydown", "wheel"] as const) {
    window.addEventListener(type, present, { capture: true, passive: true });
  }
  // The app moves focus itself; only the window gaining focus means the user is back.
  window.addEventListener("focus", (event) => {
    if (event.target === window) created.present();
  });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", () => created.left());
  created.present();
  tracker = created;
  return created;
}

/** The user's last absence, while the Needs you box should say what changed in it. */
export function useAway(): AwayWindow | null {
  return useSyncExternalStore(
    (listener) => presence().subscribe(listener),
    () => presence().getAway(),
    () => null,
  );
}

export function markCaughtUp() {
  presence().caughtUp();
}
