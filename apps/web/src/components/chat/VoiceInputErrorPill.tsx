import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { msg, t, type Message } from "~/i18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceInputPill } from "./VoiceInputPill";

interface VoiceErrorText {
  readonly label: Message;
  readonly message: Message;
}

// Keyed by the English error text the speech hooks raise; the entry holds what to show for it.
const VOICE_ERRORS: Record<string, VoiceErrorText> = {
  [MICROPHONE_PERMISSION_ERROR]: {
    label: msg("Mic blocked"),
    message: msg(
      "Microphone access is required for voice input. Allow access in your browser or system settings and try again.",
    ),
  },
  "Microphone access is required for voice input.": {
    label: msg("Mic blocked"),
    message: msg("Microphone access is required for voice input."),
  },
  "This draft is no longer available.": {
    label: msg("Draft unavailable"),
    message: msg("This draft is no longer available."),
  },
  "Another voice recording is already active.": {
    label: msg("Already recording"),
    message: msg("Another voice recording is already active."),
  },
  "Voice transcription is not available.": {
    label: msg("Voice input unavailable"),
    message: msg("Voice transcription is not available."),
  },
  "Voice transcription is still finishing. Try again shortly.": {
    label: msg("Still transcribing"),
    message: msg("Voice transcription is still finishing. Try again shortly."),
  },
  "Voice transcription is not available for this language.": {
    label: msg("Language unsupported"),
    message: msg("Voice transcription is not available for this language."),
  },
  "Could not prepare voice transcription.": {
    label: msg("Couldn’t start"),
    message: msg("Could not prepare voice transcription."),
  },
  "Could not start voice recording.": {
    label: msg("Couldn’t start"),
    message: msg("Could not start voice recording."),
  },
  "Voice recording was interrupted.": {
    label: msg("Recording interrupted"),
    message: msg("Voice recording was interrupted."),
  },
  "Could not finish voice recording.": {
    label: msg("Couldn’t finish"),
    message: msg("Could not finish voice recording."),
  },
  "Could not transcribe this recording.": {
    label: msg("Transcription failed"),
    message: msg("Could not transcribe this recording."),
  },
  "Voice transcription on this environment failed.": {
    label: msg("Transcription failed"),
    message: msg("Voice transcription on this environment failed."),
  },
  "The draft changed while voice input was running. The transcript was not added.": {
    label: msg("Draft changed"),
    message: msg("The draft changed while voice input was running. The transcript was not added."),
  },
  "No speech was detected.": {
    label: msg("No speech heard"),
    message: msg("No speech was detected."),
  },
  "Microphone processing failed.": {
    label: msg("Mic failed"),
    message: msg("Microphone processing failed."),
  },
  "The microphone disconnected.": {
    label: msg("Mic disconnected"),
    message: msg("The microphone disconnected."),
  },
};

const RETRYABLE_TRANSCRIPTIONS = new Set([
  "Could not transcribe this recording.",
  "Voice transcription on this environment failed.",
]);

export function VoiceInputErrorPill(props: {
  error: string | null;
  errorAction: "retry" | "settings" | null;
  disabled?: boolean;
  cancelShortcutLabel?: string | null;
  size?: "default" | "compact" | undefined;
  onRetry(): void;
  onDismiss(): void;
}) {
  const navigate = useNavigate();
  const known = props.error ? VOICE_ERRORS[props.error] : undefined;
  const message = known ? t(known.message) : (props.error ?? t("Voice input failed"));
  const openSettings = props.errorAction === "settings";
  const compact = props.size === "compact";
  const action = openSettings
    ? { label: t("Open voice settings"), text: t("Settings") }
    : props.error && RETRYABLE_TRANSCRIPTIONS.has(props.error)
      ? { label: t("Retry transcription"), text: t("Retry") }
      : { label: t("Record again"), text: t("Record again") };
  return (
    <VoiceInputPill tone="error" size={props.size}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={compact ? "icon-xs" : "icon-sm-pill"}
              variant="ghost"
              aria-label={t("Dismiss voice input error")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onDismiss}
              className="shrink-0"
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipPopup side="top">
          {props.cancelShortcutLabel
            ? t("Dismiss ({shortcut})", { shortcut: props.cancelShortcutLabel })
            : t("Dismiss")}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              role="status"
              aria-label={message}
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            />
          }
        >
          <CircleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{known ? t(known.label) : t("Voice input failed")}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{message}</TooltipPopup>
      </Tooltip>
      {props.errorAction ? (
        <Button
          type="button"
          size={compact ? "xs" : "sm-pill"}
          variant="outline"
          aria-label={action.label}
          disabled={props.disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (openSettings) {
              props.onDismiss();
              void navigate({ to: "/settings/voice" });
            } else {
              props.onRetry();
            }
          }}
          className="ms-auto shrink-0"
        >
          {action.text}
        </Button>
      ) : (
        <span aria-hidden className="w-1.5 shrink-0" />
      )}
    </VoiceInputPill>
  );
}
