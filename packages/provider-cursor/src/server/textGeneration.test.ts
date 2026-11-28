import type { RunResult } from "@cursor/sdk";
import { TextGenerationError } from "@t3tools/contracts/git";
import { ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { ProviderSetupError } from "@t3tools/contracts/providerSetup";
import { OnDispatch } from "@t3tools/provider-core/server/textGenerationOperations";
import { CursorSettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, vi } from "vite-plus/test";

import { makeCursorTextGeneration } from "./textGeneration.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => ({
  create: vi.fn<(options: unknown) => Promise<unknown>>(),
  send: vi.fn<(prompt: string) => Promise<unknown>>(),
  close: vi.fn(),
  cancel: vi.fn(async () => {}),
  storeOpen: vi.fn<(options: unknown) => Promise<unknown>>(),
  storeDispose: vi.fn(async () => {}),
  prompt: vi.fn<(prompt: string, options: unknown) => Promise<RunResult>>(async () => ({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  })),
}));

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({
    Agent: { create: cursorSdkMock.create },
    createAgentPlatform: vi.fn(),
  }),
  loadCursorSqlite: () => ({ SqliteLocalAgentStore: { open: cursorSdkMock.storeOpen } }),
}));

let hasCustomPolicy = false;
const layerFs = FileSystem.layerNoop({
  exists: () => Effect.succeed(hasCustomPolicy),
  makeTempDirectoryScoped: () => Effect.succeed("/isolated-text-generation"),
});
const layerTest = Layer.merge(layerFs, CursorSdk.layer);

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const cursorSettings = decodeCursorSettings({ enabled: true });

beforeEach(() => {
  hasCustomPolicy = false;
  cursorSdkMock.create.mockReset();
  cursorSdkMock.send.mockReset();
  cursorSdkMock.create.mockImplementation(async (options) => {
    cursorSdkMock.send.mockImplementation(async (prompt) => ({
      status: "running",
      cancel: cursorSdkMock.cancel,
      wait: () => cursorSdkMock.prompt(prompt, options),
    }));
    return {
      close: cursorSdkMock.close,
      [Symbol.asyncDispose]: async () => {
        cursorSdkMock.close();
      },
      send: cursorSdkMock.send,
    };
  });
  cursorSdkMock.close.mockClear();
  cursorSdkMock.cancel.mockClear();
  cursorSdkMock.storeDispose.mockClear();
  cursorSdkMock.storeOpen.mockReset();
  cursorSdkMock.storeOpen.mockResolvedValue({ dispose: cursorSdkMock.storeDispose });
  cursorSdkMock.prompt.mockReset();
  cursorSdkMock.prompt.mockResolvedValue({
    id: "run-cursor-text-generation-test",
    status: "finished",
    result:
      '{"subject":"Add generated commit message","body":"- verify cursor sdk text generation"}',
  });
});

describe("CursorTextGeneration", () => {
  it.effect("resolves the browser credential for every request after an account change", () =>
    Effect.gen(function* () {
      let apiKey = "first-browser-key";
      const generation = yield* makeCursorTextGeneration(
        cursorSettings,
        {},
        Effect.sync(() => apiKey),
      );
      const input = {
        cwd: process.cwd(),
        branch: "feature/cursor",
        stagedSummary: "M file.ts",
        stagedPatch: "diff",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "auto"),
      };
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "first-browser-key" }),
      );
      apiKey = "second-browser-key";
      yield* generation.generateCommitMessage(input);
      expect(cursorSdkMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ apiKey: "second-browser-key" }),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("continues in the temp directory when the SDK cannot sandbox", () =>
    Effect.gen(function* () {
      cursorSdkMock.create.mockImplementationOnce(async () => {
        throw new Error(
          "Local SDK sandboxing was requested, but sandboxing is not supported in this environment. Disable local.sandboxOptions.enabled or remove ~/.cursor/sandbox.json to run without sandboxing.",
        );
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-text-generation",
        stagedSummary: "M apps/server/src/textGeneration/CursorTextGeneration.ts",
        stagedPatch: "diff --git a/apps/server/src/textGeneration/CursorTextGeneration.ts",
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2"),
      });

      expect(generated.subject).toBe("Add generated commit message");
      expect(cursorSdkMock.create).toHaveBeenCalledTimes(2);
      expect(cursorSdkMock.create.mock.calls[0]?.[0]).toMatchObject({
        local: { sandboxOptions: { enabled: true } },
      });
      expect(cursorSdkMock.create.mock.calls[1]?.[0]).toMatchObject({
        local: {
          cwd: "/isolated-text-generation",
          store: { dispose: cursorSdkMock.storeDispose },
          autoReview: false,
          sandboxOptions: { enabled: false },
          settingSources: [],
          enableAgentRetries: true,
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("accepts json objects with extra assistant text around them", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-text-generation-test",
        status: "finished",
        result:
          'Sure, here is the JSON:\n```json\n{\n  "subject": "Update README dummy comment with attribution and date",\n  "body": ""\n}\n```\nDone.',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "feature/cursor-noisy-json",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.subject).toBe("Update README dummy comment with attribution and date");
      expect(generated.body).toBe("");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("generates thread titles through Cursor SDK text generation", () =>
    Effect.gen(function* () {
      cursorSdkMock.prompt.mockResolvedValueOnce({
        id: "run-cursor-title-generation-test",
        status: "finished",
        result: '{"title":"\\"Trim reconnect spinner status after resume.\\""}',
      });
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {
        CURSOR_API_KEY: "test-cursor-key",
      });

      const generated = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "Fix the reconnect spinner after a resumed session.",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
      });

      expect(generated.title).toBe("Trim reconnect spinner status after resume.");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("observes an accepted run before its finished title fails validation", () =>
    Effect.gen(function* () {
      const onDispatch = vi.fn();
      let observedBeforeWait = false;
      cursorSdkMock.prompt.mockImplementationOnce(async () => {
        observedBeforeWait = onDispatch.mock.calls.length === 1;
        return { id: "invalid-title", status: "finished", result: '{"title":123}' };
      });
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const failure = yield* Effect.flip(
        generation
          .generateThreadTitle({
            cwd: "/workspace",
            message: "Title",
            modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
          })
          .pipe(Effect.provideService(OnDispatch, onDispatch)),
      );
      expect(cursorSdkMock.send).toHaveBeenCalledOnce();
      expect(onDispatch).toHaveBeenCalledExactlyOnceWith();
      expect(failure).toBeInstanceOf(TextGenerationError);
      expect(failure.operation).toBe("generateThreadTitle");
      expect(failure.detail).toBe("Cursor SDK returned invalid structured output.");
      expect(observedBeforeWait).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["error", "cancelled"] as const)(
    "rejects a %s Cursor SDK run that includes valid title JSON",
    (status) =>
      Effect.gen(function* () {
        const onDispatch = vi.fn();
        const promptResult = {
          id: "run-cursor-partial-title-test",
          status,
          result: '{"title":"Partial title from a failed run."}',
        } satisfies RunResult;
        cursorSdkMock.prompt.mockResolvedValueOnce(promptResult);
        const generation = yield* makeCursorTextGeneration(cursorSettings, {
          CURSOR_API_KEY: "test-cursor-key",
        });
        const failure = yield* Effect.flip(
          generation
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix the reconnect spinner after a resumed session.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("cursor"),
                model: "composer-2",
              },
            })
            .pipe(Effect.provideService(OnDispatch, onDispatch)),
        );
        expect(onDispatch).toHaveBeenCalledExactlyOnceWith();
        expect(failure).toBeInstanceOf(TextGenerationError);
        expect(failure.operation).toBe("generateThreadTitle");
        expect(failure.detail).toBe(
          status === "cancelled"
            ? "Cursor SDK request was cancelled."
            : "Cursor SDK request finished with an error.",
        );
        expect(cursorSdkMock.close).toHaveBeenCalledOnce();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails closed when ambient sandbox policy can expand write access", () =>
    Effect.gen(function* () {
      const onDispatch = vi.fn();
      hasCustomPolicy = true;
      const generation = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      const failure = yield* Effect.flip(
        generation
          .generateThreadTitle({
            cwd: "/real-workspace",
            message: "Title",
            modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
          })
          .pipe(Effect.provideService(OnDispatch, onDispatch)),
      );
      expect(cursorSdkMock.send).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
      expect(failure.detail).toContain("custom ~/.cursor/sandbox.json");
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("requires CURSOR_API_KEY before calling the SDK", () =>
    Effect.gen(function* () {
      const textGeneration = yield* makeCursorTextGeneration(cursorSettings, {});

      const error = yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/cursor-api-key",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cursor"),
            model: "composer-2",
          },
        }),
      );

      expect(error.detail).toBe("Sign in with Cursor or add CURSOR_API_KEY in provider settings.");
      expect(error.retryable).toBe(false);
      expect(cursorSdkMock.prompt).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("marks disabled Cursor settings and usage/auth SDK errors non-retryable", () =>
    Effect.gen(function* () {
      const disabled = yield* makeCursorTextGeneration(decodeCursorSettings({ enabled: false }), {
        CURSOR_API_KEY: "key",
      });
      const disabledError = yield* Effect.flip(
        disabled.generateThreadTitle({
          cwd: process.cwd(),
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        }),
      );
      expect(disabledError.retryable).toBe(false);

      const enabled = yield* makeCursorTextGeneration(cursorSettings, { CURSOR_API_KEY: "key" });
      for (const [rejection, expectedRetryable] of [
        [Object.assign(new Error("Usage limit"), { code: "PRO_USER_USAGE_LIMIT" }), false],
        [Object.assign(new Error("Invalid key"), { status: 401 }), false],
        [new Error("ECONNRESET: socket hang up"), undefined],
      ] as const) {
        cursorSdkMock.prompt.mockRejectedValueOnce(rejection);
        const error = yield* Effect.flip(
          enabled.generateThreadTitle({
            cwd: process.cwd(),
            message: "Title",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cursor"),
              model: "composer-2",
            },
          }),
        );
        expect(error.retryable).toBe(expectedRetryable);
      }

      const transientAccess = yield* makeCursorTextGeneration(
        cursorSettings,
        { CURSOR_API_KEY: "key" },
        undefined,
        () =>
          Effect.fail(
            new ProviderSetupError({
              instanceId: ProviderInstanceId.make("cursor"),
              operation: "session",
              detail: "Cursor sign-in or sign-out is in progress. Try again after it finishes.",
            }),
          ),
      );
      const transientAccessError = yield* Effect.flip(
        transientAccess.generateThreadTitle({
          cwd: process.cwd(),
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        }),
      );
      expect(transientAccessError.retryable).toBeUndefined();

      const permanentKeyError = yield* makeCursorTextGeneration(
        cursorSettings,
        {},
        Effect.fail(
          new ProviderSetupError({
            instanceId: ProviderInstanceId.make("cursor"),
            operation: "credentials",
            detail: "Sign in with Cursor or add CURSOR_API_KEY in provider settings.",
            retryable: false,
          }),
        ),
      );
      const permanentError = yield* Effect.flip(
        permanentKeyError.generateThreadTitle({
          cwd: process.cwd(),
          message: "Title",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
        }),
      );
      expect(permanentError.retryable).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );
});
