import { type EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { t } from "../../lib/i18n";

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

export function projectThreadContentPresentation(input: {
  readonly hasDetail: boolean;
  readonly detailError: string | null;
  readonly detailDeleted: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
}): ThreadContentPresentation {
  if (input.hasDetail) {
    return { kind: "ready" };
  }
  if (input.detailDeleted) {
    return {
      kind: "unavailable",
      title: t("Thread unavailable"),
      detail: t("This thread was deleted or is no longer available."),
    };
  }
  if (input.detailError !== null) {
    return {
      kind: "unavailable",
      title: t("Could not load conversation"),
      detail: input.detailError,
      retryable: true,
    };
  }
  if (
    input.connectionState === "connected" ||
    input.connectionState === "connecting" ||
    input.connectionState === "reconnecting"
  ) {
    return { kind: "loading" };
  }
  return {
    kind: "unavailable",
    title: t("Messages not cached"),
    detail: t("Reconnect this environment to load the conversation."),
  };
}
