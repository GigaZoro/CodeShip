import type { DesktopBridge, DesktopLoginItemState } from "@t3tools/contracts";
import { t } from "~/i18n";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

type DesktopLoginItemBridge = DesktopBridge["loginItem"];

class DesktopLoginItemUnavailableError extends Schema.TaggedError<DesktopLoginItemUnavailableError>()(
  "DesktopLoginItemUnavailableError",
  {},
) {
  override get message(): string {
    return t("Open at login is unavailable.");
  }
}

class DesktopLoginItemLoadError extends Schema.TaggedError<DesktopLoginItemLoadError>()(
  "DesktopLoginItemLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return t("Failed to check whether T3.CodeShip opens at login.");
  }
}

/** Missing on web, and on a desktop app older than this setting. */
export function getDesktopLoginItemBridge(): DesktopLoginItemBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.loginItem;
}

const loadDesktopLoginItemState = Effect.fn("loadDesktopLoginItemState")(function* () {
  const bridge = getDesktopLoginItemBridge();
  if (!bridge) {
    return yield* new DesktopLoginItemUnavailableError();
  }
  return yield* Effect.tryPromise({
    try: (): Promise<DesktopLoginItemState> => bridge.getState(),
    catch: (cause) => new DesktopLoginItemLoadError({ cause }),
  });
});

export const desktopLoginItemStateAtom = Atom.make(loadDesktopLoginItemState()).pipe(
  // The user can change it in the OS too, so Settings checks again when it mounts.
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("desktop:login-item:load"),
);

export function refreshDesktopLoginItemState(): void {
  appAtomRegistry.refresh(desktopLoginItemStateAtom);
}
