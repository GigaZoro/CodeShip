import type { LinkedPrompt } from "@t3tools/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";

import { t, tn } from "~/i18n";
export function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: t("This prompt had hidden characters, it may be malicious"),
    description: tn(
      prompt.hiddenCharacters,
      "T3.CodeShip removed {count} hidden character. Read the prompt before you send it.",
      "T3.CodeShip removed {count} hidden characters. Read the prompt before you send it.",
    ),
    timeout: 0,
  });
}

export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt,
  notes: ReadonlyArray<string> = [],
): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    useComposerDraftStore.getState().setPrompt(target, prompt.text);
    toastManager.add({
      type: "info",
      title: t("Prompt added from a link"),
      description: [t("Read it before you send."), ...notes].join(" "),
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: t("Linked prompt ready"),
    description: t("This thread already has a draft. Replace it with the linked prompt?"),
    timeout: 0,
    actionProps: {
      children: t("Replace draft"),
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
