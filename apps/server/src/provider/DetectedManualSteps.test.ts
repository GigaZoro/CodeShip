import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderMcpError,
  type ProviderMcpListResult,
  type ProviderMcpServer,
  type ServerProvider,
} from "@t3tools/contracts";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AccountRouting from "../orchestration-v2/AccountRouting.ts";
import * as DetectedManualSteps from "./DetectedManualSteps.ts";
import { selectDetectedManualSteps } from "./DetectedManualSteps.ts";
import * as ProviderMcp from "./ProviderMcp.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const IN_DAYS = (days: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + days * 86_400_000));

const provider = (
  instanceId: string,
  overrides: Partial<Omit<ServerProvider, "auth">> & { auth?: ServerProvider["auth"] } = {},
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId.split("_")[0]!),
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    ...overrides,
  }) as ServerProvider;

const server = (name: string, overrides: Partial<ProviderMcpServer> = {}): ProviderMcpServer => ({
  name,
  status: "needsAuth",
  origin: "config",
  canSignIn: true,
  canSignOut: false,
  removable: false,
  ...overrides,
});

const select = (
  providers: ReadonlyArray<ServerProvider>,
  mcp: Record<string, ReadonlyArray<ProviderMcpServer>> = {},
  appCapped: ReadonlyArray<string> = [],
) =>
  selectDetectedManualSteps({
    machine: "Mac",
    providers,
    mcpServers: new Map(
      Object.entries(mcp).map(([id, servers]) => [ProviderInstanceId.make(id), servers]),
    ),
    appCapped: new Set(appCapped.map((id) => ProviderInstanceId.make(id))),
    nowMs: NOW,
  });

describe("selectDetectedManualSteps", () => {
  it("reports an enabled, installed account that is signed out", () => {
    const steps = select([
      provider("codex", { auth: { status: "unauthenticated" } }),
      provider("cursor", { enabled: false, auth: { status: "unauthenticated" } }),
      provider("grok", { installed: false, auth: { status: "unauthenticated" } }),
      provider("opencode", { auth: { status: "unknown" } }),
    ]);
    assert.deepEqual(
      steps.map(({ id, kind, machine }) => ({ id, kind, machine })),
      [{ id: "signed-out:codex:", kind: "signed-out", machine: "Mac" }],
    );
  });

  it("skips an unavailable account: another provider owns its sign-in", () => {
    assert.deepEqual(
      select([
        provider("codex_2", { availability: "unavailable", auth: { status: "unauthenticated" } }),
      ]),
      [],
    );
  });

  it("reports a signed-in account ChatGPT's connected-app limit stopped", () => {
    const steps = select(
      [
        provider("codex", { auth: { status: "authenticated" } }),
        provider("codex_out", { auth: { status: "unauthenticated" } }),
        provider("codex_off", { enabled: false, auth: { status: "authenticated" } }),
        provider("codex_free", { auth: { status: "authenticated" } }),
      ],
      {},
      ["codex", "codex_out", "codex_off"],
    );
    assert.deepEqual(
      steps.map(({ id, kind }) => ({ id, kind })),
      [
        { id: "connected-app-cap:codex:", kind: "connected-app-cap" },
        { id: "signed-out:codex_out:", kind: "signed-out" },
      ],
    );
  });

  it("warns about a login that ends within 7 days and reports one that has ended", () => {
    const steps = select([
      provider("claudeAgent_soon", {
        displayName: "Vitalii" as never,
        auth: { status: "authenticated", loginExpiresAt: IN_DAYS(6.5) },
      }),
      provider("claudeAgent_later", {
        auth: { status: "authenticated", loginExpiresAt: IN_DAYS(20) },
      }),
      provider("claudeAgent_lapsed", {
        auth: { status: "unauthenticated", loginExpiresAt: IN_DAYS(-1) },
      }),
    ]);
    assert.deepEqual(
      steps.map(({ kind, instanceId, accountName }) => ({ kind, instanceId, accountName })),
      [
        { kind: "login-expiring", instanceId: "claudeAgent_soon", accountName: "Vitalii" },
        { kind: "login-expired", instanceId: "claudeAgent_lapsed", accountName: undefined },
      ],
    );
    assert.equal(steps[0]?.expiresAt, IN_DAYS(6.5));
  });

  it("reports a lapsed login once even though the account also reads as signed out", () => {
    const steps = select([
      provider("claudeAgent", { auth: { status: "unauthenticated", loginExpiresAt: IN_DAYS(-3) } }),
    ]);
    assert.deepEqual(
      steps.map((step) => step.kind),
      ["login-expired"],
    );
  });

  it("reports MCP servers that need signing in, one step per account and server", () => {
    const needsAuth = [server("threadpage"), server("minions", { displayName: "Minions" })];
    const steps = select(
      [provider("claudeAgent_a"), provider("claudeAgent_b"), provider("codex")],
      {
        claudeAgent_a: needsAuth,
        claudeAgent_b: [...needsAuth, server("threadpage")],
        codex: [server("ok", { status: "connected" })],
      },
    );
    assert.deepEqual(
      steps.map(({ id }) => id),
      [
        "mcp-needs-auth:claudeAgent_a:threadpage",
        "mcp-needs-auth:claudeAgent_a:minions",
        "mcp-needs-auth:claudeAgent_b:threadpage",
        "mcp-needs-auth:claudeAgent_b:minions",
      ],
    );
    assert.equal(steps[1]?.serverDisplayName, "Minions");
  });

  it("leaves out servers the account cannot sign in, plugin servers, and disabled accounts", () => {
    assert.deepEqual(
      select([provider("claudeAgent"), provider("codex", { enabled: false })], {
        claudeAgent: [
          server("no-flow", { canSignIn: false }),
          server("bundled", { origin: "plugin" }),
          server("failed", { status: "failed" }),
        ],
        codex: [server("minions")],
      }),
      [],
    );
  });
});

describe("DetectedManualSteps discovery", () => {
  const claude = ProviderInstanceId.make("claudeAgent");

  const harness = (
    listRecent: (starts: Ref.Ref<number>) => Effect.Effect<ProviderMcpListResult, ProviderMcpError>,
  ) =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      const layer = DetectedManualSteps.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([provider("claudeAgent")]),
            }),
            Layer.mock(ProviderMcp.ProviderMcp)({
              listRecent: () =>
                Ref.update(starts, (count) => count + 1).pipe(Effect.andThen(listRecent(starts))),
            }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getDescriptor: Effect.succeed({ label: "Mac" } as never),
            }),
            Layer.mock(AccountRouting.AccountRouting)({ holds: Effect.succeed([]) }),
          ),
        ),
      );
      return { starts, layer };
    });

  const mcpStepIds = (service: DetectedManualSteps.DetectedManualSteps["Service"]) =>
    service.list.pipe(Effect.map((result) => result.steps.map((step) => step.id)));

  it.effect(
    "keeps a slow discovery running after a request gives up and joins it on the next poll",
    () =>
      Effect.gen(function* () {
        const { starts, layer } = yield* harness(() =>
          Effect.sleep("50 seconds").pipe(Effect.as({ servers: [server("threadpage")] })),
        );
        yield* Effect.gen(function* () {
          const service = yield* DetectedManualSteps.DetectedManualSteps;
          const first = yield* mcpStepIds(service).pipe(Effect.forkChild);
          yield* TestClock.adjust("26 seconds");
          assert.deepEqual(yield* Fiber.join(first), []);

          // Past the 20 s answer cache; the discovery from the first request is still running.
          yield* TestClock.adjust("21 seconds");
          const second = yield* mcpStepIds(service).pipe(Effect.forkChild);
          yield* TestClock.adjust("5 seconds");
          assert.deepEqual(yield* Fiber.join(second), ["mcp-needs-auth:claudeAgent:threadpage"]);
          assert.equal(yield* Ref.get(starts), 1);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "does not start a provider that failed to list again until the retry delay has passed",
    () =>
      Effect.gen(function* () {
        const { starts, layer } = yield* harness(() =>
          Effect.fail(
            new ProviderMcpError({
              operation: "list",
              instanceId: claude,
              reason: "providerFailed",
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* DetectedManualSteps.DetectedManualSteps;
          yield* mcpStepIds(service);
          // Past the 20 s answer cache, so each poll below looks at the provider again.
          yield* TestClock.adjust("1 minute");
          yield* mcpStepIds(service);
          yield* TestClock.adjust("1 minute");
          assert.deepEqual(yield* mcpStepIds(service), []);
          assert.equal(yield* Ref.get(starts), 1);

          yield* TestClock.adjust("4 minutes");
          yield* mcpStepIds(service);
          assert.equal(yield* Ref.get(starts), 2);
        }).pipe(Effect.provide(layer));
      }),
  );
});
