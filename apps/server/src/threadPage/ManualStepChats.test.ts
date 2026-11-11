import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  type ManualStepStartChatInput,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManualStepChats from "./ManualStepChats.ts";

const scratchProjectId = ProjectId.make("project:scratch");
const signedOut = ProviderInstanceId.make("codex");
const signedIn = ProviderInstanceId.make("claude_second");

const claude = ProviderDriverKind.make("claudeAgent");

const provider = (
  instanceId: ProviderInstanceId,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: claude,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-11T11:59:00.000Z",
  models: [
    { slug: "small", name: "Small", isCustom: false, capabilities: null },
    { slug: "large", name: "Large", isCustom: false, isDefault: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const input: ManualStepStartChatInput = {
  commandId: CommandId.make("command:decide"),
  creationSource: "mobile",
  step: {
    threadId: "contabo",
    title: "Move the VPS contract to a 12-month term",
    step: "in the Contabo panel, move the VPS to a 12-month term.",
    kind: "needs-you",
    machine: "MacBook-Pro",
    url: "https://thread.page/app/threads/contabo",
  },
  decision: { _tag: "Other", text: "Keep the monthly term and close this step." },
};

type SettingsOverrides = Parameters<typeof ServerSettings.layerTest>[0];

interface Scenario {
  readonly settings?: SettingsOverrides;
  /** The model of the chat an earlier attempt with this command id already started. */
  readonly startedModel?: ModelSelection;
}

const layerFor = (
  providers: ReadonlyArray<ServerProvider>,
  launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>,
  { settings, startedModel }: Scenario,
) =>
  ManualStepChats.layer.pipe(
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId: scratchProjectId }),
      }),
    ),
    Layer.provide(Layer.mock(Project.ProjectService)({ getById: () => Effect.succeedNone })),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            startedModel === undefined
              ? null
              : ({ deletedAt: null, modelSelection: startedModel } as Effect.Success<
                  ReturnType<ThreadManagement.ThreadManagementService["Service"]["getThreadShell"]>
                >),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (request) =>
          Ref.update(launches, (seen) => [...seen, request]).pipe(
            Effect.as({
              threadId: ThreadId.make("thread:decision"),
              resumed: false,
            } as ThreadLaunch.ThreadLaunchResult),
          ),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        ...settings,
        providerInstances: {
          [signedOut]: { driver: claude },
          [signedIn]: { driver: claude },
          ...settings?.providerInstances,
        },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

const start = (providers: ReadonlyArray<ServerProvider>, scenario: Scenario = {}) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    const result = yield* ManualStepChats.ManualStepChats.pipe(
      Effect.flatMap((chats) => chats.start(input)),
      Effect.provide(layerFor(providers, launches, scenario).pipe(Layer.orDie)),
      Effect.result,
    );
    return { result, launches: yield* Ref.get(launches) };
  });

describe("ManualStepChats", () => {
  it.effect("starts a No project chat on the first account that can run it", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([
        provider(signedOut, { auth: { status: "unauthenticated" } }),
        provider(signedIn),
      ]);
      expect(result).toMatchObject({ _tag: "Success", success: { threadId: "thread:decision" } });
      expect(launches).toHaveLength(1);
      const [launch] = launches;
      expect(launch).toMatchObject({
        commandId: input.commandId,
        threadId: input.commandId,
        projectId: scratchProjectId,
        title: "Move the VPS contract to a 12-month term",
        modelSelection: { instanceId: signedIn, model: "large" },
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "mobile",
      });
      const text = launch?.initialMessage?.text ?? "";
      expect(text).toContain("My decision: Keep the monthly term and close this step.");
      expect(text).toContain("https://thread.page/app/threads/contabo");
      expect(text).toContain("Spend only what my decision above explicitly approves.");
    }),
  );

  it.effect.each([
    ["is turned off", { enabled: false }, provider(signedOut)],
    ["is signed out", {}, provider(signedOut, { auth: { status: "unauthenticated" } })],
  ] as const)("skips a default model whose account %s", ([, instance, defaultAccount]) =>
    Effect.gen(function* () {
      const { launches } = yield* start([defaultAccount, provider(signedIn)], {
        settings: {
          defaultModelSelection: { instanceId: signedOut, model: "small" },
          providerInstances: { [signedOut]: { driver: claude, ...instance } },
        },
      });
      expect(launches[0]?.modelSelection).toEqual({ instanceId: signedIn, model: "large" });
    }),
  );

  it.effect("moves an auto-account default off a turned-off account, keeping its model", () =>
    Effect.gen(function* () {
      const { launches } = yield* start([provider(signedOut), provider(signedIn)], {
        settings: {
          defaultModelSelection: { instanceId: signedOut, model: "small", autoAccount: true },
          providerInstances: { [signedOut]: { driver: claude, enabled: false } },
        },
      });
      expect(launches[0]?.modelSelection).toEqual({
        instanceId: signedIn,
        model: "small",
        autoAccount: true,
      });
    }),
  );

  it.effect("replays a repeated request on the model its chat started with", () =>
    Effect.gen(function* () {
      const startedModel = { instanceId: signedOut, model: "small" };
      const { result, launches } = yield* start([provider(signedOut, { enabled: false })], {
        startedModel,
      });
      expect(result._tag).toBe("Success");
      expect(launches[0]).toMatchObject({
        threadId: input.commandId,
        modelSelection: startedModel,
      });
    }),
  );

  it.effect("starts nothing when no account can run a chat", () =>
    Effect.gen(function* () {
      const { result, launches } = yield* start([provider(signedOut, { enabled: false })]);
      expect(result._tag === "Failure" ? result.failure.reason : null).toBe("no-model");
      expect(launches).toHaveLength(0);
    }),
  );
});
