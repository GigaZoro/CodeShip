import { getFormattingLocale, t, tn } from "~/i18n";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerLegacyThreadMigrationAtom } from "../state/server";
import { toastManager } from "./ui/toast";

type MigrationToastId = ReturnType<typeof toastManager.add>;

/** A loading toast for as long as the primary server reports a legacy thread migration running. */
export function startLegacyThreadMigrationToast(): () => void {
  let toastId: MigrationToastId | null = null;

  const unsubscribe = appAtomRegistry.subscribe(
    primaryServerLegacyThreadMigrationAtom,
    (migration) => {
      if (migration?.status === "running") {
        if (toastId !== null) return;
        toastId = toastManager.add({
          type: "loading",
          title: t("Restoring your threads…"),
          description: tn(
            migration.totalThreadCount,
            "Migrating {total} thread from the previous version. You can keep working while this finishes.",
            "Migrating {total} threads from the previous version. You can keep working while this finishes.",
            { total: migration.totalThreadCount.toLocaleString(getFormattingLocale()) },
          ),
          timeout: 0,
        });
        return;
      }

      if (toastId !== null) {
        toastManager.close(toastId);
        toastId = null;
      }
    },
    { immediate: true },
  );

  return () => {
    unsubscribe();
    if (toastId !== null) toastManager.close(toastId);
  };
}
