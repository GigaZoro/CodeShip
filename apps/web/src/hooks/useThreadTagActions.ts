import { collectThreadTags, parseThreadTag } from "@t3tools/client-runtime/state/thread-tag-filter";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";

import { requestThreadFolderName } from "../components/ThreadFolderNameDialog";
import type { buildThreadTagsMenuItem } from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { t } from "../i18n";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { orchestrationEnvironment } from "../state/orchestration";
import { environmentThreadShells } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";

function tagIsHidden(ref: ScopedThreadRef, tag: string): boolean {
  return (
    appAtomRegistry
      .get(serverEnvironment.hiddenThreadTagsAtom(ref.environmentId))
      ?.includes(tag) === true
  );
}

export function readThreadTagsMenuState(
  refs: readonly ScopedThreadRef[],
): Parameters<typeof buildThreadTagsMenuItem>[0] {
  const available = collectThreadTags(
    appAtomRegistry.get(environmentThreadShells.quietThreadShellsAtom),
  );
  const tagsByTarget = refs.map((ref) => new Set(readThreadShell(ref)?.source.tags));
  return {
    canEdit: refs.every(
      (ref) =>
        appAtomRegistry.get(
          orchestrationEnvironment.v2.dispatchCommand.permissionAtom(ref.environmentId, {
            type: "thread.tag.set",
          }),
        ) === true,
    ),
    entries: available
      .filter((tag) => !refs.some((ref) => tagIsHidden(ref, tag)))
      .map((tag) => ({
        tag,
        checked: tagsByTarget.every((tags) => tags.has(tag)),
      })),
  };
}

export function useThreadTagActions() {
  const setTag = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand, {
    reportFailure: false,
  });
  return async (action: string, refs: readonly ScopedThreadRef[]) => {
    const add = action.startsWith("tag:add:");
    const remove = action.startsWith("tag:remove:");
    if (action !== "tag:new" && !add && !remove) return false;

    const tag =
      action === "tag:new"
        ? await requestThreadFolderName({
            title: t("Add tag…"),
            submitLabel: t("Add tag"),
            fieldLabel: t("Tag name"),
            initialName: "",
            maxLength: 64,
            isValid: (value) => parseThreadTag(value) !== null,
          })
        : parseThreadTag(action.slice(add ? "tag:add:".length : "tag:remove:".length));
    if (tag === null) return true;
    if (refs.some((ref) => tagIsHidden(ref, tag))) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: t("That tag is hidden in this environment.") }),
      );
      return true;
    }
    const results = await Promise.all(
      refs.map((ref) =>
        setTag({
          environmentId: ref.environmentId,
          input: {
            type: "thread.tag.set",
            commandId: CommandId.make(randomUUID()),
            threadId: ref.threadId,
            tag,
            tagged: !remove,
          },
        }),
      ),
    );
    if (results.some((result) => result._tag === "Failure" && !isAtomCommandInterrupted(result))) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: t("Failed to update thread tags") }),
      );
    }
    return true;
  };
}
