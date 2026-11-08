import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { autoCoordinatorAccount } from "./autoCoordinatorAccount.ts";

const first = ProviderInstanceId.make("codex_first");
const second = ProviderInstanceId.make("codex_second");
const provider = (
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-08T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("autoCoordinatorAccount", () => {
  it.each([
    {
      name: "respects failover order",
      overrides: {},
      limited: [],
      capable: [first, second],
      expected: first,
    },
    {
      name: "skips a usage-limited account",
      overrides: {},
      limited: [first],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips a signed-out account",
      overrides: { auth: { status: "unauthenticated" } },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "skips a disabled account",
      overrides: { enabled: false },
      limited: [],
      capable: [first, second],
      expected: second,
    },
    {
      name: "requires an orchestration adapter",
      overrides: {},
      limited: [],
      capable: [second],
      expected: second,
    },
    {
      name: "returns none when no account can run",
      overrides: {},
      limited: [first, second],
      capable: [first, second],
      expected: undefined,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    overrides: Partial<ServerProvider>;
    limited: ProviderInstanceId[];
    capable: ProviderInstanceId[];
    expected: ProviderInstanceId | undefined;
  }>)("$name", ({ overrides, limited, capable, expected }) => {
    expect(
      autoCoordinatorAccount({
        driver: ProviderDriverKind.make("claudeAgent"),
        providers: [provider(second), provider(first, overrides)],
        settings: { providerInstanceFailoverOrder: [first, second] },
        limitedAccounts: new Map(limited.map((id) => [id, "2026-11-09T00:00:00.000Z"])),
        orchestrationCapableInstanceIds: new Set(capable),
      })?.instanceId,
    ).toBe(expected);
  });
  it("uses Claude for a Codex coordinator and returns none without another provider", () => {
    const input = {
      driver: ProviderDriverKind.make("codex"),
      providers: [provider(first, { driver: ProviderDriverKind.make("claudeAgent") })],
      settings: { providerInstanceFailoverOrder: [] },
      limitedAccounts: new Map<ProviderInstanceId, string>(),
      orchestrationCapableInstanceIds: new Set([first]),
    };
    expect(autoCoordinatorAccount(input)?.instanceId).toBe(first);
    expect(autoCoordinatorAccount({ ...input, providers: [] })).toBeUndefined();
  });
});
