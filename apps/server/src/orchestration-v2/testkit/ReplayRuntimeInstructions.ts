import type {
  ProviderDriverKind,
  ProviderReplayEntry,
  ProviderReplayTranscript,
} from "@t3tools/contracts";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  if (runtime.driver === "muse") {
    return {
      ...transcript,
      entries: transcript.entries.map((entry) => {
        const turnStart = entry.type === "expect_outbound" ? museTurnStart(entry.frame) : undefined;
        if (turnStart === undefined) return entry;
        const { frame, params, input } = turnStart;
        const instructions = { type: "text", text: museInstructions(params, runtime.model) };
        return {
          ...entry,
          frame: { ...frame, params: { ...params, input: [instructions, ...input] } },
        };
      }),
    };
  }
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : runtime.driver === "fx"
            ? "fx"
            : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        return frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          lastPart.text === instructions
        ) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}

/** Muse fixtures record turn/start without the instructions part, so a wording change needs no re-recording. */
export function stripMuseReplayRuntimeInstructions(
  entries: ReadonlyArray<ProviderReplayEntry>,
  model: string,
): ReadonlyArray<ProviderReplayEntry> {
  return entries.map((entry) => {
    const turnStart = entry.type === "expect_outbound" ? museTurnStart(entry.frame) : undefined;
    if (turnStart === undefined) return entry;
    const { frame, params, input } = turnStart;
    const [first, ...rest] = input;
    if (!isRecord(first) || first.text !== museInstructions(params, model)) return entry;
    return { ...entry, frame: { ...frame, params: { ...params, input: rest } } };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function museTurnStart(frame: unknown) {
  if (!isRecord(frame) || frame.method !== "turn/start" || !isRecord(frame.params))
    return undefined;
  const { params } = frame;
  const input: ReadonlyArray<unknown> | undefined = Array.isArray(params.input)
    ? params.input
    : undefined;
  return input === undefined ? undefined : { frame, params, input };
}

// The adapter sends the turn's effort both as reasoningEffort and inside the instructions.
function museInstructions(params: Record<string, unknown>, model: string): string {
  return buildRuntimeInstructions({
    harness: "Muse Code",
    model,
    reasoningEffort:
      typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
  });
}
