import { forkSession, getSessionMessages, resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
);

const ClaudeSettingsRead = Schema.Struct({
  cwd: Schema.String,
  settingSources: Schema.Array(Schema.Literals(["user", "project", "local"])),
});
export type ClaudeSettingsRead = typeof ClaudeSettingsRead.Type;

const decodeSettingsReads = Schema.decodeSync(
  Schema.fromJsonString(Schema.Array(ClaudeSettingsRead)),
);

/** The settings sources of each read; the server runs this in-process for its own config folder. */
export const resolveClaudeSettingsSources = (reads: ReadonlyArray<ClaudeSettingsRead>) =>
  Promise.all(
    reads.map(
      async (read) =>
        (await resolveSettings({ cwd: read.cwd, settingSources: [...read.settingSources] }))
          .sources,
    ),
  );

/** `input` is the session id, or for resolveSettings the reads as JSON. */
export async function runClaudeHistoryWorker(
  method: string | undefined,
  input: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  if (!input) throw new Error("Claude history worker input is required.");
  if (method === "resolveSettings") {
    process.stdout.write(
      JSON.stringify(await resolveClaudeSettingsSources(decodeSettingsReads(input))),
    );
    return;
  }
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(input, options)
      : method === "forkSession"
        ? await forkSession(input, options).then(async (forked) => {
            const headMessageId = await getSessionMessages(forked.sessionId, options)
              .then((messages) => messages.at(-1)?.uuid)
              .catch(() => undefined);
            return headMessageId === undefined ? forked : { ...forked, headMessageId };
          })
        : (() => {
            throw new Error("Unknown Claude history operation.");
          })();
  process.stdout.write(JSON.stringify(result));
}
