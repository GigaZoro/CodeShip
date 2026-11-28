import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts/baseSchemas";
import { PreviewTabId } from "@t3tools/contracts/preview";
import {
  PREVIEW_HEADLESS_NOTE,
  type PreviewAutomationRequest,
} from "@t3tools/contracts/previewAutomation";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { claimPreviewRecording, layerStandard } from "./handlers.ts";
import { PreviewStandardToolkit } from "./tools.ts";

const provideToolScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-1"),
      requestNamespace: "provider-session-1",
      thread: {
        threadId: ThreadId.make("thread-1"),
        providerSessionId: "provider-session-1",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["preview"] as const),
      issuedAt: 1,
    }),
    Effect.provide(
      Layer.mergeAll(PreviewAutomationBroker.layer, liveThreadsLayer).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("preview_open navigates the opened tab to a dev server in one tool call", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const tabId = PreviewTabId.make("opened-tab");
      const target = {
        kind: "environment-port" as const,
        port: 3000,
        path: "/settings?tab=account",
      };
      const requests: PreviewAutomationRequest[] = [];
      const status = {
        available: true,
        visible: false,
        tabId,
        url: "http://localhost:3000/settings?tab=account",
        title: "Settings",
        loading: false,
      };
      const events = yield* broker.connect({
        clientId: "client-1",
        environmentId: scope.environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        requests.push(event.request);
        return broker.respond({
          clientId: "client-1",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: event.request.operation === "open" ? { ...status, url: "about:blank" } : status,
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
      );
      const results = yield* toolkit
        .handle("preview_open", {
          url: "http://localhost:3000",
          target,
          open: false,
          reuseExistingTab: false,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(results.at(-1)?.result).toEqual(status);
      expect(requests.map(({ operation, input }) => ({ operation, input }))).toEqual([
        { operation: "open", input: { open: false, show: false, reuseExistingTab: false } },
        { operation: "navigate", input: { target } },
      ]);
      expect(requests[1]?.tabId).toBe(tabId);
      expect(requests[1]?.tabIdExplicit).toBe(true);
    }).pipe(provideToolScope),
  ),
);

it.effect("preview_evaluate says when it ran in the server's headless browser", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const headlessTab = PreviewTabId.make("headless-tab");
      const events = yield* broker.connect({
        clientId: "client-1",
        environmentId: scope.environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        const { operation, requestId, tabId } = event.request;
        return broker.respond({
          clientId: "client-1",
          connectionId: event.connectionId,
          requestId,
          ok: true,
          result:
            operation === "evaluate"
              ? 42
              : { available: true, visible: false, tabId, url: null, title: null, loading: false },
          ...(operation === "evaluate" && tabId === headlessTab ? { headless: true } : {}),
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const toolkit = yield* PreviewStandardToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(layerStandard)),
      );
      const evaluate = (tabId: string) =>
        toolkit
          .handle("preview_evaluate", { tabId: PreviewTabId.make(tabId), expression: "6 * 7" })
          .pipe(Stream.unwrap, Stream.runCollect);

      expect((yield* evaluate(headlessTab)).at(-1)?.result).toEqual({
        value: 42,
        headless: true,
        headlessNote: PREVIEW_HEADLESS_NOTE,
      });
      expect((yield* evaluate("desktop-tab")).at(-1)?.result).toEqual({ value: 42 });
    }).pipe(provideToolScope),
  ),
);

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );
});
