import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";

import { useClientSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { archiveThreadWithConfirm } from "../lib/archiveThreadWithConfirm";
import { readEnvironmentServerConfigLoaded } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { pickSnoozePreset, resolveSnoozePresets } from "./Sidebar.snooze";
import { requestThreadRename } from "./ThreadRenameDialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

const SNOOZE_ROW_PREFIX = "action:thread-snooze:";

/** Whether the active thread's rows include snooze choices, so the snooze shortcut has a list to open. */
export function hasSnoozeRows(items: ReadonlyArray<CommandPaletteActionItem>): boolean {
  return items.some((item) => item.value.startsWith(SNOOZE_ROW_PREFIX));
}

function failureToast(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Pin, settle, snooze, archive and rename for the thread on screen, through the sidebar menu's commands. */
export function useActiveThreadPaletteItems(
  thread: EnvironmentThreadShell | null | undefined,
): ReadonlyArray<CommandPaletteActionItem> {
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    archiveThread,
  } = useThreadActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const confirmThreadArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  // The clock read in render would freeze in the compiler's cache, so presets follow the minute tick.
  const nowMinute = useNowMinute();
  const canOperate = useEnvironmentScope(
    thread?.environmentId ?? ("" as EnvironmentThreadShell["environmentId"]),
    AuthOrchestrationOperateScope,
  );
  if (!thread || !canOperate) return [];

  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const configLoaded = readEnvironmentServerConfigLoaded(thread.environmentId);
  const now = new Date(`${nowMinute}:00.000Z`);
  const items: CommandPaletteActionItem[] = [];

  if (configLoaded) {
    const pinned = thread.pinnedAt != null;
    items.push({
      kind: "action",
      value: "action:thread-pin",
      searchTerms: ["pin", "unpin", "favorite", "keep", "thread"],
      title: pinned ? "Unpin thread" : "Pin thread",
      icon: pinned ? (
        <PinOffIcon className={ITEM_ICON_CLASS} />
      ) : (
        <PinIcon className={ITEM_ICON_CLASS} />
      ),
      shortcutCommand: "thread.pin",
      run: async () => {
        failureToast(
          pinned ? "Failed to unpin thread" : "Failed to pin thread",
          await (pinned ? confirmAndUnpinThread(threadRef) : pinThread(threadRef)),
        );
      },
    });

    const settled = thread.settledOverride === "settled";
    items.push({
      kind: "action",
      value: "action:thread-settle",
      searchTerms: ["settle", "unsettle", "done", "finish", "close", "thread"],
      title: settled ? "Un-settle thread" : "Settle thread",
      icon: <CheckCircle2Icon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.settle",
      run: async () => {
        failureToast(
          settled ? "Failed to un-settle thread" : "Failed to settle thread",
          await (settled ? unsettleThread(threadRef) : settleThread(threadRef)),
        );
      },
    });

    if (effectiveSnoozed(thread, { now: now.toISOString() })) {
      items.push({
        kind: "action",
        value: "action:thread-unsnooze",
        searchTerms: ["snooze", "wake", "unsnooze", "thread"],
        title: "Wake thread",
        icon: <AlarmClockOffIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          failureToast("Failed to wake thread", await unsnoozeThread(threadRef));
        },
      });
    } else if (canSnooze(thread, { now: now.toISOString() })) {
      const presets = resolveSnoozePresets(now, timestampFormat, thread.environmentId);
      const snoozeWith = async (snoozedUntil: string) =>
        failureToast("Failed to snooze thread", await snoozeThread(threadRef, snoozedUntil));
      for (const [index, preset] of presets.entries()) {
        items.push({
          kind: "action",
          value: `${SNOOZE_ROW_PREFIX}${preset.id}`,
          searchTerms: ["snooze", "later", "remind", "hide", "thread", preset.label],
          title: `Snooze: ${preset.label}`,
          description: preset.whenLabel,
          icon: <AlarmClockIcon className={ITEM_ICON_CLASS} />,
          // The shortcut lists the presets rather than picking one, so only the first row shows it.
          ...(index === 0 ? { shortcutCommand: "thread.snooze" as const } : {}),
          run: async () => {
            const picked = pickSnoozePreset(
              presets,
              preset.id,
              timestampFormat,
              thread.environmentId,
            );
            if (picked) await snoozeWith(picked.snoozedUntil);
          },
        });
      }
      items.push({
        kind: "action",
        value: `${SNOOZE_ROW_PREFIX}custom`,
        searchTerms: ["snooze", "later", "remind", "custom", "thread"],
        title: "Snooze: Custom…",
        icon: <AlarmClockIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          const choice = await requestCustomSnooze();
          if (choice) await snoozeWith(choice.snoozedUntil);
        },
      });
    }
  }

  items.push({
    kind: "action",
    value: "action:thread-rename",
    searchTerms: ["rename", "title", "name", "thread"],
    title: "Rename thread",
    icon: <PencilIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      requestThreadRename({ threadRef, title: thread.title });
    },
  });

  const running = !threadRuntimeCanArchive(thread.runtime);
  items.push({
    kind: "action",
    value: "action:thread-archive",
    searchTerms: ["archive", "hide", "remove", "thread"],
    title: "Archive thread",
    description: running ? "Stop the agent first" : undefined,
    disabled: running,
    icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "thread.archive",
    run: () =>
      archiveThreadWithConfirm({
        threadRef,
        title: thread.title,
        confirm: confirmThreadArchive,
        archiveThread,
      }),
  });

  return items;
}
