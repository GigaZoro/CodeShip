import type { EnvironmentId, ThreadId } from "@t3tools/contracts/baseSchemas";
import {
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts/orchestratorMcp";
import { PEER_LINK_AGENTS_ONLY_NOTE } from "@t3tools/contracts/peerLink";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

const TOOL_REQUEST_DEADLINES: Readonly<Record<string, Duration.Duration>> = {
  // Worktree preparation is asynchronous, but preflighting a base can fetch and retry a ref lock.
  t3_thread_launch: Duration.seconds(90),
  // A page can carry up to 100 items of 50,000 characters plus metadata and MCP encoding.
  t3_thread_read: Duration.minutes(2),
  // The synchronous clone can try both SSH and HTTPS, with up to 120 s per attempt.
  t3_project_clone: Duration.seconds(270),
  // A prompt file read can do two 60 s Git network operations before reading the blob.
  schedule_task: Duration.minutes(3),
  run_scheduled_task_now: Duration.minutes(3),
  // Guide generation runs in the background, but the request can preflight 20 PR heads in batches.
  write_pull_request_guides: Duration.minutes(5),
  // A guide read refreshes forge metadata, including an optional credential fallback.
  read_pull_request_guide: Duration.minutes(2),
};

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     * `ignorableArguments` are as for `PeerMcpClient.call`.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
      ignorableArguments?: ReadonlyArray<string>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `orchestrator_capabilities` there. */
    readonly readCapabilities: (
      scope: Scope,
      environmentId: EnvironmentId,
    ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, in pieces short enough to survive any route. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** `t3_thread_organize` there, settling `threadId`. */
    readonly settleThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** What an agent hears when it names another machine while the beta is off here. */
export const linkedEnvironmentsOff = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Machines & access → Linked environments.",
});

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /**
   * The caller's own limits, which travel with every forwarded call: the peer sees only the
   * link's credential, so a caller that may not control threads here is refused here. Work a
   * link started never uses this environment's links, since the peer would see this
   * environment's session instead of that link, and its fence could not hold.
   */
  const callerLimits = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.map((caller) => caller.limits),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
    ignorableArguments?: ReadonlyArray<string>,
  ) {
    const limits = yield* callerLimits(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    return yield* peers.call({
      environmentId,
      tool: toolName,
      arguments: args,
      limits,
      success: success as Schema.Decoder<A>,
      ...(ignorableArguments === undefined ? {} : { ignorableArguments }),
      deadline: Object.hasOwn(TOOL_REQUEST_DEADLINES, toolName)
        ? TOOL_REQUEST_DEADLINES[toolName]
        : undefined,
    });
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = Effect.fn(
    "PeerForwarding.waitForThread",
  )(function* (scope, environmentId, input) {
    let remaining = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    let runId = input.runId;
    while (true) {
      const chunk = Math.min(remaining, PeerMcpClient.FORWARDED_WAIT_CHUNK_MS);
      const result = yield* forward<OrchestratorMcpThreadWaitResult>(
        scope,
        "t3_thread_wait",
        OrchestratorMcpThreadWaitInput,
        OrchestratorMcpThreadWaitResult,
        environmentId,
        {
          threadId: input.threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: chunk,
          ...(input.untilDelegatedWorkSettled === undefined
            ? {}
            : { untilDelegatedWorkSettled: input.untilDelegatedWorkSettled }),
        },
      );
      remaining -= chunk;
      if (!result.timedOut || remaining <= 0) return result;
      // Later pieces wait for the run the first one picked, not a newer one.
      runId = result.runId ?? undefined;
    }
  });

  const organizeTool = ThreadToolkit.tools.t3_thread_organize;
  const settleThread: PeerForwarding["Service"]["settleThread"] = (
    scope,
    environmentId,
    threadId,
  ) =>
    forward(
      scope,
      organizeTool.name,
      organizeTool.parametersSchema,
      organizeTool.successSchema,
      environmentId,
      { threadId, action: "settle" },
    ).pipe(Effect.asVoid);

  // While the beta is off, agents start nothing over links. Tasks already running there keep
  // following through readThread, waitForThread, interruptThread and settleThread, so they
  // still finish.
  const requireEnabled = links.enabled.pipe(
    Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(linkedEnvironmentsOff))),
  );

  const call: PeerForwarding["Service"]["call"] = (
    scope,
    tool,
    environmentId,
    params,
    ignorableArguments,
  ) => {
    const forwarded: Effect.Effect<
      Tool.Success<typeof tool>,
      OrchestratorMcpFailure
    > = tool.name === "t3_thread_wait"
      ? (waitForThread(
          scope,
          environmentId,
          params as OrchestratorMcpThreadWaitInput,
        ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
      : forward(
          scope,
          tool.name,
          tool.parametersSchema,
          tool.successSchema,
          environmentId,
          params,
          ignorableArguments,
        );
    return Effect.andThen(requireEnabled, forwarded);
  };

  const readCapabilities: PeerForwarding["Service"]["readCapabilities"] = (scope, environmentId) =>
    Effect.andThen(
      requireEnabled,
      forward<OrchestratorMcpCapabilitiesResult>(
        scope,
        "orchestrator_capabilities",
        OrchestratorMcpCapabilitiesInput,
        OrchestratorMcpCapabilitiesResult,
        environmentId,
        {},
      ),
    );

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* callerLimits(scope);
      yield* requireEnabled;
      const listed = yield* links.list.pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
          ...(link.versionWarning === undefined ? {} : { versionWarning: link.versionWarning }),
        })),
        notListed: NOT_LISTED,
        appList: PEER_LINK_AGENTS_ONLY_NOTE,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readCapabilities,
    readThread,
    interruptThread,
    waitForThread,
    settleThread,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
