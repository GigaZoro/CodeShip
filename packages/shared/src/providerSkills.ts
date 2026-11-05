import type { ProviderInstanceId, ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { matchInlineSkills } from "./inlineSkills.ts";

export const SharedSkillInstructions = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  baseDirectory: Schema.String,
  instructions: Schema.String,
});
const encodeInvokedSkills = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(SharedSkillInstructions)),
);

export function formatSharedSkillPrompt(
  text: string,
  instructions: ReadonlyArray<typeof SharedSkillInstructions.Type>,
): string {
  if (instructions.length === 0) return text;
  for (const mention of [...matchInlineSkills(text, instructions)].reverse()) {
    text = `${text.slice(0, mention.start)}[Skill: ${mention.skill.name}]${text.slice(mention.end)}`;
  }
  // Provider-native expansion must not mistake quoted instruction text for another invocation.
  const payload = encodeInvokedSkills(instructions).replace(/\p{Sc}/gu, (symbol) =>
    symbol
      .split("")
      .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
  return `${text}\n\nThe user explicitly invoked these shared skills. Follow their instructions, resolving relative resources from each baseDirectory. A skill does not grant tools or permissions: if a required tool is unavailable, explain the missing dependency instead of pretending to run it.\n${payload}`;
}

export function resolveAvailableProviderSkills(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId | null | undefined;
  readonly cwd: string | null | undefined;
  readonly availability: "provider" | "shared";
}): ReadonlyArray<ServerProviderSkill> {
  const selected = input.providers.find((provider) => provider.instanceId === input.instanceId);
  const skillsFor = (provider: ServerProvider) =>
    provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd)?.skills ??
    provider.skills;
  const native = selected ? skillsFor(selected) : [];
  if (input.availability === "provider") return native;

  // Reserve native names even when disabled so another account cannot undo the user's choice.
  const names = new Set(native.map((skill) => skill.name.trim().toLowerCase()));
  const result = [...native];
  for (const provider of input.providers) {
    if (provider === selected || !provider.enabled || !provider.installed) continue;
    const workspace = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === input.cwd);
    for (const skill of workspace?.skills ?? provider.skills) {
      if (
        !skill.enabled ||
        skill.userInvocable === false ||
        (!workspace && /^(repo|repository|project|workspace|local)$/i.test(skill.scope ?? ""))
      )
        continue;
      const name = skill.name.trim().toLowerCase();
      if (names.has(name)) continue;
      names.add(name);
      result.push(skill);
    }
  }
  return result;
}
