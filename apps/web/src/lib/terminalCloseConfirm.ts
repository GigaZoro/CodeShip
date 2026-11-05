import { readLocalApi } from "~/localApi";
import { t, tn } from "~/i18n";

let pendingConfirmations = 0;

export function isTerminalCloseConfirmPending(): boolean {
  return pendingConfirmations > 0;
}

export async function confirmTerminalClose(
  labels: readonly [string, ...string[]],
): Promise<boolean> {
  const localApi = readLocalApi();
  if (!localApi) return true;
  pendingConfirmations += 1;
  try {
    return await localApi.dialogs.confirm(
      labels.length === 1
        ? [
            t('Close terminal "{label}"?', { label: labels[0] }),
            t("This stops the running process and clears its history."),
          ].join("\n")
        : [
            tn(labels.length, "Close {count} terminal?", "Close {count} terminals?"),
            tn(
              labels.length,
              "This stops its running process and clears its history: {terminals}.",
              "This stops their running processes and clears their histories: {terminals}.",
              { terminals: labels.map((label) => `"${label}"`).join(", ") },
            ),
          ].join("\n"),
      { variant: "destructive" },
    );
  } catch {
    return false;
  } finally {
    pendingConfirmations -= 1;
  }
}
