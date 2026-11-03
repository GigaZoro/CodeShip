import * as Schema from "effect/Schema";

/** The kind of work an agent hands to a delegated task; settings can pick a model per kind. */
export const DelegatedTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type DelegatedTaskRole = typeof DelegatedTaskRole.Type;
