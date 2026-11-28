import { CommandId, ThreadId } from "@t3tools/contracts/baseSchemas";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts/orchestrationV2";
import { OrchestratorMcpFailure } from "@t3tools/contracts/orchestratorMcp";
import type {
  ThreadMetadataMcpAction,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts/threadMetadataMcp";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { threadNotFound } from "./threadAccess.ts";

export class ThreadMetadataMcpService extends Context.Service<
  ThreadMetadataMcpService,
  {
    readonly update: (
      scope: McpInvocationScope,
      input: ThreadMetadataMcpUpdateInput,
    ) => Effect.Effect<ThreadMetadataMcpUpdateResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadMetadataMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function commandId(input: {
  readonly scope: McpInvocationScope;
  readonly threadId: ThreadId;
  readonly action: ThreadMetadataMcpAction;
  readonly requestKey: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      "thread-update",
      stablePart(input.threadId),
      stablePart(input.action),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function metadataCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly update: ThreadMetadataMcpUpdateInput;
}): Extract<
  OrchestrationV2Command,
  { readonly type: "thread.metadata.update" | "thread.notification-level.set" | "thread.color.set" }
> {
  switch (input.update.action) {
    case "rename":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        title: input.update.title!,
      };
    case "set_notification_level":
      return {
        type: "thread.notification-level.set",
        commandId: input.commandId,
        threadId: input.threadId,
        notificationLevel: input.update.notificationLevel!,
      };
    case "set_color":
      return {
        type: "thread.color.set",
        commandId: input.commandId,
        threadId: input.threadId,
        color: input.update.color!,
      };
    case "regenerate_title":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        regenerateTitle: true,
      };
  }
}

function resultFromThread(input: {
  readonly action: ThreadMetadataMcpAction;
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "id"
    | "title"
    | "titleRegeneration"
    | "linkedPullRequest"
    | "updatedAt"
    | "notificationLevel"
    | "color"
  >;
}): ThreadMetadataMcpUpdateResult {
  return {
    threadId: input.thread.id,
    action: input.action,
    commandId: input.commandId,
    sequence: input.sequence,
    title: input.thread.title,
    notificationLevel: input.thread.notificationLevel ?? "default",
    color: input.thread.color ?? null,
    titleRegeneration:
      input.thread.titleRegeneration === undefined || input.thread.titleRegeneration === null
        ? null
        : {
            requestId: input.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(input.thread.titleRegeneration.startedAt),
          },
    linkedPullRequest: input.thread.linkedPullRequest ?? null,
    updatedAt: DateTime.formatIso(input.thread.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const update = Effect.fn("ThreadMetadataMcpService.update")(function* (
    scope: McpInvocationScope,
    input: ThreadMetadataMcpUpdateInput,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }

    const threadId = input.threadId ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a T3.CodeShip thread.",
      );
    }
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to locate thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    const requestKey =
      input.clientRequestId === undefined
        ? yield* crypto.randomUUIDv4().pipe(Effect.orDie)
        : input.clientRequestId;
    const updateCommandId = commandId({
      scope,
      threadId,
      action: input.action,
      requestKey,
    });
    const dispatched = yield* threadManagement
      .dispatch(
        metadataCommand({
          commandId: updateCommandId,
          threadId,
          update: input,
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to ${input.action} for thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    const metadataEvent = dispatched.storedEvents
      .map((stored) => stored.event)
      .find(
        (
          event,
        ): event is Extract<OrchestrationV2DomainEvent, { payload: OrchestrationV2AppThread }> =>
          event.type === "thread.metadata-updated" ||
          event.type === "thread.notification-level-updated" ||
          event.type === "thread.color-updated",
      );
    // Retries may find stored events compacted away; answer from the projection.
    const thread =
      metadataEvent !== undefined
        ? metadataEvent.payload
        : yield* threadManagement
            .getThreadShell(threadId)
            .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
    if (thread === null) {
      return yield* failure(
        "orchestration_error",
        `Thread ${threadId} metadata update completed without a resultant state.`,
      );
    }
    return resultFromThread({
      action: input.action,
      commandId: updateCommandId,
      sequence: dispatched.sequence,
      thread,
    });
  });

  return ThreadMetadataMcpService.of({ update });
});

export const layer: Layer.Layer<
  ThreadMetadataMcpService,
  never,
  Crypto.Crypto | ThreadManagementService.ThreadManagementService
> = Layer.effect(ThreadMetadataMcpService, make);
