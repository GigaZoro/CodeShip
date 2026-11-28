import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts/baseSchemas";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ProviderMcpSetEnabledInput } from "@t3tools/contracts/providerMcp";
import type { ProviderRetryUsageLimitResult } from "@t3tools/contracts/providerUsageLimits";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as AccountRouting from "../../../orchestration-v2/AccountRouting.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderMcp from "../../../provider/ProviderMcp.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProviderMcpHandlers from "./handlers.ts";
import { ProviderMcpToolkit } from "./tools.ts";

const instanceId = ProviderInstanceId.make("codex");

const clientScope = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:provider-mcp"),
  requestNamespace: "client:provider-mcp",
  thread: undefined,
  client: { sessionId: "provider-mcp", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

it.effect("a read-only client lists provider MCP servers but cannot turn one off", () =>
  Effect.gen(function* () {
    const switched = yield* Ref.make<ReadonlyArray<ProviderMcpSetEnabledInput>>([]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ProviderMcp.ProviderMcp)({
        list: () =>
          Effect.succeed({
            servers: [
              {
                name: "docs",
                status: "connected",
                origin: "config",
                canSignIn: false,
                canSignOut: false,
                removable: true,
              },
            ],
          }),
        setEnabled: (input) => Ref.update(switched, (all) => [...all, input]),
      }),
    );
    const call = (
      access: McpInvocationContext.McpClientCaller["access"],
      params: { readonly action: "list" | "disable" | "edit"; readonly name?: string },
    ) =>
      Effect.gen(function* () {
        const toolkit = yield* ProviderMcpToolkit;
        const results = yield* toolkit
          .handle("t3_provider_mcp_servers", { instanceId, ...params })
          .pipe(Stream.unwrap, Stream.runCollect);
        return results.at(-1)?.result;
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope(access)),
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProviderMcpHandlers.layer).pipe(
            Layer.provideMerge(dependencies),
          ),
        ),
      );

    expect(yield* call("read-only", { action: "list" })).toMatchObject({
      servers: [{ name: "docs" }],
    });
    expect(yield* call("read-only", { action: "disable", name: "docs" })).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* call("full-access", { action: "edit", name: "docs" })).toMatchObject({
      code: "invalid_request",
    });
    expect(yield* call("full-access", { action: "disable", name: "docs" })).toMatchObject({
      message: "Turned off docs; its settings are kept. New sessions leave it out.",
    });
    expect(yield* Ref.get(switched)).toEqual([{ instanceId, name: "docs", enabled: false }]);
  }),
);

it.effect("only a full-access client releases a usage-limited account", () =>
  Effect.gen(function* () {
    const released = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
    const admission = yield* Ref.make<ProviderRetryUsageLimitResult>({});
    const retry = (access: McpInvocationContext.McpClientCaller["access"]) =>
      Effect.gen(function* () {
        const toolkit = yield* ProviderMcpToolkit;
        const results = yield* toolkit
          .handle("t3_provider_retry_usage_limit", { instanceId })
          .pipe(Stream.unwrap, Stream.runCollect);
        return results.at(-1)?.result;
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, clientScope(access)),
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProviderMcpHandlers.layer).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Layer.mock(ThreadManagement.ThreadManagementService)({}),
                Layer.mock(ProviderMcp.ProviderMcp)({}),
                Layer.mock(AccountRouting.AccountRouting)({
                  retryAccount: (id) =>
                    Ref.update(released, (all) => [...all, id]).pipe(
                      Effect.andThen(Ref.get(admission)),
                    ),
                }),
              ),
            ),
          ),
        ),
      );

    expect(yield* retry("read-only")).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(released)).toEqual([]);
    expect(yield* retry("full-access")).toEqual({
      message: "Released codex. New work can start on it now.",
    });
    expect(yield* Ref.get(released)).toEqual([instanceId]);

    yield* Ref.set(admission, { credits: "spending" });
    expect(yield* retry("full-access")).toEqual({
      message:
        "Released codex. New work can start on it now. It runs on the prepaid credits the user allowed for this work.",
    });

    yield* Ref.set(admission, { limitedUntil: "2026-11-06T00:00:00.000Z", credits: "not_enabled" });
    expect(yield* retry("full-access")).toEqual({
      message:
        "Released codex's recorded refusals, but new work still cannot start on it until 2026-11-06T00:00:00.000Z: a usage limit holds it, and spending its prepaid credits is off. That is the user's money: only the user turns it on, with Spend prepaid credits in Settings > Providers.",
    });
  }),
);
