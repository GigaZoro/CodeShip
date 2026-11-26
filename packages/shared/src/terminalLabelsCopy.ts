import { t } from "./i18n.ts";
import { terminalNumber } from "./terminalLabels.ts";

export { resolveTerminalSessionLabel } from "./terminalLabels.ts";

/** @public The default terminal label for client display. */
export function getTerminalLabel(terminalId: string, resolve: typeof t = t): string {
  const numericSuffix = terminalNumber(terminalId);
  return numericSuffix ? resolve("Terminal {number}", { number: numericSuffix }) : terminalId;
}
