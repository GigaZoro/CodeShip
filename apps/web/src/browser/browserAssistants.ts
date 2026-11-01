import {
  type BrowserAssistantKind,
  type ClientSettings,
  type ResolvedBrowserAssistant,
  type ScopedThreadRef,
  resolveBrowserAssistants,
  resolveBrowserProfiles,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { ClaudeAI, OpenAI, type Icon } from "~/components/Icons";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { openUrlInPreview } from "./openFileInPreview";

export const BROWSER_ASSISTANTS: Readonly<
  Record<
    BrowserAssistantKind,
    { readonly label: string; readonly url: string; readonly Icon: Icon }
  >
> = {
  dot: { label: "ChatGPT dot", url: "https://chatgpt.com/dots", Icon: OpenAI },
  // Duet has no page of its own on the web; Anthropic opens it from claude.ai.
  duet: { label: "Claude Duet", url: "https://claude.ai/", Icon: ClaudeAI },
};

export const browserAssistantLabel = (assistant: ResolvedBrowserAssistant) =>
  `${BROWSER_ASSISTANTS[assistant.kind].label} · ${assistant.profile.name}`;

const selectBrowserAssistants = (settings: ClientSettings) =>
  resolveBrowserAssistants(
    settings.browserAssistants,
    resolveBrowserProfiles(settings.browserProfiles),
  );

export function useBrowserAssistants(): ReadonlyArray<ResolvedBrowserAssistant> {
  return useClientSettings(selectBrowserAssistants);
}

/** Opens in the browser panel because only its profile carries the account's sign-in. */
export function useOpenBrowserAssistant(threadRef: ScopedThreadRef) {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  return async (assistant: ResolvedBrowserAssistant) => {
    const result = await openUrlInPreview({
      threadRef,
      url: BROWSER_ASSISTANTS[assistant.kind].url,
      openPreview,
      profileId: assistant.profileId,
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Unable to open ${browserAssistantLabel(assistant)}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
}
