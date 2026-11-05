import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderSkills from "./ProviderSkills.ts";

export const layer = Layer.mock(ProviderSkills.ProviderSkills)({
  expandSkillMentions: ({ text }) => Effect.succeed(text),
});
