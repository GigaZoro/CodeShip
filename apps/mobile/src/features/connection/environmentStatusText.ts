import { t } from "../../lib/i18n";
import {
  connectionErrorText,
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import type { MarkedText } from "@t3tools/client-runtime/errors";

/** Connection error text from runtime state, in the current language when the error is marked. */
export function runtimeConnectionErrorText(
  state: { readonly connectionError: string | null; readonly i18nConnectionError?: MarkedText },
  resolve: typeof t = t,
): string | null {
  return connectionErrorText(
    {
      error: state.connectionError,
      ...(state.i18nConnectionError === undefined ? {} : { i18nError: state.i18nConnectionError }),
    },
    resolve,
  );
}

export function environmentStatusText(
  connection: EnvironmentConnectionPresentation,
  resolve: typeof t = t,
): string {
  const error = connectionErrorText(connection, resolve);
  return connection.phase === "unsupported" && error !== null
    ? error
    : connectionStatusText(connection, resolve);
}
