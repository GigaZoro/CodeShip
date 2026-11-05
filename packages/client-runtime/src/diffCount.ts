import { getFormattingLocale } from "@t3tools/shared/i18n";

export function formatDiffCount(count: number): string {
  return new Intl.NumberFormat(getFormattingLocale()).format(count);
}
