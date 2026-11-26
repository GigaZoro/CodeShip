import { useAtomValue } from "@effect/atom-react";
import {
  threadPreferenceCommand,
  threadPreferenceMenuItems,
} from "@t3tools/client-runtime/thread-preferences";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Atom } from "effect/reactivity";
import { uuidv4 } from "../../lib/uuid";
import { t } from "../../lib/i18n";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type Thread = Pick<EnvironmentThreadShell, "id" | "environmentId" | "notificationLevel" | "color">;

export function useThreadPreferenceMenu(thread: Thread | undefined) {
  const capabilities = useAtomValue(
    serverEnvironment.threadPreferenceCapabilitiesAtom(thread?.environmentId ?? null),
  );
  const allowed = useAtomValue(
    thread ? threadEnvironment.setPreferences.permissionAtom(thread.environmentId) : denied,
  );
  const run = useAtomCommand(
    threadEnvironment.setPreferences,
    t("Failed to update thread preferences"),
  );
  const items = thread && allowed ? threadPreferenceMenuItems(thread, capabilities) : [];
  const select = (action: string) => {
    if (!thread || !items.some((item) => item.children.some((child) => child.id === action)))
      return false;
    const command = threadPreferenceCommand(action, thread.id, uuidv4);
    if (!command) return false;
    void run({ environmentId: thread.environmentId, input: command });
    return true;
  };
  return { items, select };
}

const denied = Atom.make(false);
