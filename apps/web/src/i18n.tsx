import { translateToParts, type MessageKey } from "@t3tools/shared/i18n";
import { createElement, Fragment, type ReactNode } from "react";

export { getFormattingLocale, msg, t, tn, type Message } from "@t3tools/shared/i18n";

/** `t` for a sentence whose placeholders hold elements, such as a link inside the text. */
export function tx<M extends string>(
  message: MessageKey<M>,
  values: Readonly<Record<string, ReactNode>>,
): ReactNode {
  return createElement(Fragment, null, ...translateToParts<M, ReactNode>(message, values));
}
