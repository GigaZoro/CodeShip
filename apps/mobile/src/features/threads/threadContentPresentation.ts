import { msg, t } from "../../lib/i18n";
import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadContentPresentation =
  | { readonly kind: "ready" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "unavailable";
      readonly title: string;
      readonly detail: string;
      /** The load failed and trying again can succeed; the feed offers a Retry action. */
      readonly retryable?: true;
    };

// Shared so the thread screen's props keep their identity across renders.
export const THREAD_CONTENT_READY: ThreadContentPresentation = { kind: "ready" };
const THREAD_CONTENT_LOADING: ThreadContentPresentation = { kind: "loading" };

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly resolve?: typeof t;
}): ThreadContentPresentation {
  const resolve = input.resolve ?? t;
  if (input.hasDetail) {
    return THREAD_CONTENT_READY;
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: resolve(msg("Thread unavailable")),
      detail: resolve(msg("This thread was deleted or is no longer available.")),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: resolve(msg("Could not load conversation")),
      detail: input.detailError,
      retryable: true,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    return THREAD_CONTENT_LOADING;
  }
  return {
    kind: "unavailable",
    title: resolve(msg("Messages not cached")),
    detail: resolve(msg("Reconnect this environment to load the conversation.")),
  };
}

export function threadSyncStatusLabel(
  status: EnvironmentThreadStatus,
  presentation: ThreadContentPresentation["kind"],
  hasError: boolean,
  resolve: typeof t = t,
): string | null {
  if (status !== "empty" && status !== "cached" && status !== "synchronizing") return null;
  if (presentation === "ready") {
    return hasError ? resolve(msg("Could not sync messages")) : resolve(msg("Syncing messages…"));
  }
  return presentation === "loading" ? resolve(msg("Loading messages…")) : null;
}
