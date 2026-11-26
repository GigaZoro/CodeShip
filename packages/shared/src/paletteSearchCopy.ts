import { msg, t, type Message } from "./i18n.ts";
import type { SearchMatchHintField } from "./paletteSearch.ts";

const MATCH_HINT_LABELS: Readonly<Record<SearchMatchHintField, Message>> = {
  "pull-request": msg("PR"),
  branch: msg("Branch"),
  project: msg("Project"),
  environment: msg("Environment"),
  reference: msg("ID or link"),
};

/** @public */
export function searchMatchHintLabel(field: SearchMatchHintField, resolve: typeof t = t): string {
  return resolve(MATCH_HINT_LABELS[field]);
}
