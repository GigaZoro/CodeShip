import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { withSameAccountMarks } from "./providerAccounts.ts";

const provider = (
  instanceId: string,
  email: string | undefined,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId.startsWith("codex") ? "codex" : "claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", ...(email === undefined ? {} : { email }) },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const owners = (providers: ReadonlyArray<ServerProvider>) =>
  Object.fromEntries(
    withSameAccountMarks(providers).map((marked) => [marked.instanceId, marked.unavailableReason]),
  );

it.each([
  {
    name: "the default instance keeps an account a later instance shares",
    providers: [
      provider("claudeAgent_personal", "Ada@Example.com", { displayName: "Personal" }),
      provider("claudeAgent", "ada@example.com"),
    ],
    duplicates: { claudeAgent_personal: "Claude" },
  },
  {
    name: "the lowest id keeps it among added instances, and every duplicate names it",
    providers: [
      provider("claudeAgent_c", "ada@example.com"),
      provider("claudeAgent_b", "ada@example.com", { displayName: "Bee" }),
      provider("claudeAgent_a", "ada@example.com", { displayName: "Work" }),
    ],
    duplicates: { claudeAgent_b: "Work", claudeAgent_c: "Work" },
  },
  {
    name: "different drivers, unknown emails, and signed-out or disabled instances never clash",
    providers: [
      provider("claudeAgent", "ada@example.com"),
      provider("codex", "ada@example.com"),
      provider("claudeAgent_token", undefined),
      provider("claudeAgent_out", "ada@example.com", { auth: { status: "unauthenticated" } }),
      provider("claudeAgent_off", "ada@example.com", { enabled: false }),
    ],
    duplicates: {},
  },
  {
    name: "an added account that skipped sign-in shares Claude's login even without an email",
    providers: [
      provider("claudeAgent_personal", undefined, {
        auth: { status: "authenticated", profileId: "claude.ai:/home/ada/.claude" },
      }),
      provider("claudeAgent", undefined, {
        auth: { status: "authenticated", profileId: "claude.ai:/home/ada/.claude" },
      }),
      provider("claudeAgent_token", undefined, {
        auth: { status: "authenticated", profileId: "oauth-token:0123456789abcdef" },
      }),
    ],
    duplicates: { claudeAgent_personal: "Claude" },
  },
  {
    name: "a mark clears once the account is no longer shared",
    providers: [
      provider("claudeAgent_personal", "personal@example.com", {
        availability: "unavailable",
        unavailableReason: "Signed in to the same account as Claude.",
      }),
      provider("claudeAgent", "ada@example.com"),
    ],
    duplicates: {},
  },
])("$name", ({ providers, duplicates }) => {
  const marked = owners(providers);
  for (const { instanceId } of providers) {
    const owner = duplicates[instanceId as keyof typeof duplicates];
    if (owner === undefined) assert.isUndefined(marked[instanceId], instanceId);
    else assert.include(marked[instanceId], `same account as ${owner}.`, instanceId);
  }
});
