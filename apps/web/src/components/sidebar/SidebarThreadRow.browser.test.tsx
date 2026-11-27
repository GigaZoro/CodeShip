import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskListResult,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useComposerDraftStore } from "../../composerDraftStore";
import { makeThreadFixture } from "../../test-fixtures";
import { useThreadOutboxStore } from "../../threadOutboxStore";
import { TooltipProvider } from "../ui/tooltip";
import { SortableThreadRow, type SidebarProviderEntry } from "./SidebarThreadRow";

const localEnvId = EnvironmentId.make("local-env");
const remoteEnvId = EnvironmentId.make("remote-env");
const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("codex-default");

const mockConnectionByEnvironmentId = new Map<
  EnvironmentId,
  {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly connectionState: "connected" | "offline" | "reconnecting";
    readonly lastSeenAt: number | null;
  }
>();

const mockServerConfigs = new Map<EnvironmentId, object>([
  [localEnvId, {}],
  [remoteEnvId, {}],
]);

const scheduledTasksAtom = Atom.make(AsyncResult.success<ScheduledTaskListResult>({ tasks: [] }));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: () => scheduledTasksAtom,
    },
  };
});

vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useServerConfigs: (() => mockServerConfigs) as never,
  };
});

vi.mock(import("../../state/environments"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useEnvironmentConnectionSummary: ((environmentId: EnvironmentId) =>
      mockConnectionByEnvironmentId.get(environmentId) ?? null) as never,
  };
});

const testProject: EnvironmentProject = {
  environmentId: localEnvId,
  id: projectId,
  title: "CodeShip",
  workspaceRoot: "/repo/codeship",
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:00:00.000Z",
};

const testProviderEntry: SidebarProviderEntry = {
  instanceId: providerInstanceId,
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
  displayName: "Codex",
  accentColor: undefined,
  acpRegistryAgentId: undefined,
  acpRegistryIconUrl: undefined,
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: null,
    },
  ],
};

const providerEntries = new Map<string, SidebarProviderEntry>([
  [providerInstanceId, testProviderEntry],
]);

function makeScheduledTask(threadId: ThreadId): ScheduledTask {
  return {
    id: ScheduledTaskId.make("scheduled-1"),
    title: "Daily check",
    prompt: "Run daily check",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId,
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-11-27T00:00:00.000Z",
    updatedAt: "2026-11-27T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    placement: "chat",
    pinOrderKey: null,
    group: null,
  };
}

function makePrLink(number: number, title: string): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "org/repo",
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    source: "manual",
    linkedAt: "2026-11-27T00:00:00.000Z",
    snapshot: {
      title,
      state: "open",
      isDraft: false,
      headBranch: "feat/row-markers",
      baseBranch: "main",
      updatedAt: "2026-11-27T00:00:00.000Z",
      syncedAt: "2026-11-27T00:00:00.000Z",
    },
    stack: null,
  };
}

function setup() {
  const stack = new DisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());

  mockConnectionByEnvironmentId.clear();
  stack.defer(() => mockConnectionByEnvironmentId.clear());

  registry.set(scheduledTasksAtom, AsyncResult.success<ScheduledTaskListResult>({ tasks: [] }));

  const initialDrafts = useComposerDraftStore.getState();
  stack.defer(() => useComposerDraftStore.setState(initialDrafts, true));
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });

  const initialOutbox = useThreadOutboxStore.getState();
  stack.defer(() => useThreadOutboxStore.setState(initialOutbox, true));
  useThreadOutboxStore.setState({ messages: [] });

  return { registry, [Symbol.dispose]: () => stack.dispose() };
}

function makeShell(
  environmentId: EnvironmentId,
  overrides: Partial<ReturnType<typeof makeThreadFixture>["source"]> = {},
) {
  const base = makeThreadFixture({
    environmentId,
    projectId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  }).source;
  return presentThreadShell(environmentId, {
    ...base,
    ...overrides,
  });
}

function makeRowProps(
  overrides: Partial<Parameters<typeof SortableThreadRow>[0]> & {
    thread: ReturnType<typeof makeShell>;
  },
): Parameters<typeof SortableThreadRow>[0] {
  return {
    sortableId: null,
    copy: false,
    sortableDisabled: true,
    contextDrag: false,
    variant: "card",
    inMachineFolder: false,
    inProjectFolder: false,
    variantAction: "settle",
    settlementSupported: true,
    snoozeSupported: false,
    pinningSupported: true,
    isPinned: false,
    dropVerb: null,
    dragOverPinned: false,
    sweepAction: null,
    snoozeWakeLabelText: null,
    wokeAt: null,
    isActive: false,
    isRouteThread: false,
    openPullRequestsInRightPanel: false,
    jumpLabel: null,
    currentEnvironmentId: localEnvId,
    environmentLabel: "Remote box",
    environmentMachine: "server",
    scratchMachineLabel: null,
    project: testProject,
    projectDisplayName: "CodeShip",
    providerEntryByInstanceId: providerEntries,
    timestampFormat: "24-hour",
    onThreadClick: vi.fn(),
    onThreadActivate: vi.fn(),
    onStartRename: vi.fn(),
    onRenameTitleChange: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    isRenaming: false,
    renamingTitle: "",
    onContextMenu: vi.fn(),
    onSettle: vi.fn(),
    onActionSweepStart: vi.fn(),
    onUnsettle: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onAcknowledgeWoke: vi.fn(),
    ...overrides,
  };
}

describe("SidebarThreadRow marker priority", () => {
  it("renders at most one marker on a multi-marker row and moves overflow markers to ThreadHoverCard in priority order", async () => {
    using env = setup();
    const threadId = ThreadId.make("thread-all-markers");
    const thread = makeShell(remoteEnvId, {
      id: threadId,
      title: "Deploy release",
      pinnedAt: DateTime.makeUnsafe("2026-11-27T01:00:00.000Z"),
      tags: ["ops", "urgent"],
      color: "red",
      notificationLevel: "muted",
      pullRequests: [makePrLink(42, "Deploy release")],
      pendingRuntimeRequest: {
        requestId: RuntimeRequestId.make("req-1"),
        kind: "command",
        title: "Run deploy",
        detail: null,
        createdAt: DateTime.makeUnsafe("2026-11-27T00:00:00.000Z"),
      } as never,
      status: "running",
      latestRunId: RunId.make("run-all-markers"),
      activeRunId: RunId.make("run-all-markers"),
    });
    mockConnectionByEnvironmentId.set(remoteEnvId, {
      environmentId: remoteEnvId,
      environmentLabel: "Remote box",
      connectionState: "offline",
      lastSeenAt: Date.parse("2026-11-27T00:00:00.000Z"),
    });
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(remoteEnvId, threadId), "Unsent follow-up");
    useThreadOutboxStore.setState({
      messages: [
        {
          id: "queued-1",
          environmentId: remoteEnvId,
          threadId,
          prompt: "Next step",
          attachments: [],
          createdAt: "2026-11-27T00:00:00.000Z",
        },
      ] as never,
    });
    env.registry.set(
      scheduledTasksAtom,
      AsyncResult.success<ScheduledTaskListResult>({ tasks: [makeScheduledTask(threadId)] }),
    );

    await using screen = await render(
      <RegistryContext.Provider value={env.registry}>
        <TooltipProvider delay={0}>
          <ul>
            <SortableThreadRow {...makeRowProps({ thread, isPinned: true })} />
          </ul>
        </TooltipProvider>
      </RegistryContext.Provider>,
    );

    const row = screen.getByTestId("sidebar-row-card");
    await expect.element(row).toBeVisible();

    const rowMarkers = Array.from(row.element().querySelectorAll("[data-row-marker]")).map((node) =>
      node.getAttribute("data-row-marker"),
    );
    expect(rowMarkers).toEqual(["needsYou"]);

    await userEvent.hover(row);
    await vi.waitFor(() => {
      const hoverCard = document.querySelector('[data-slot="tooltip-popup"]');
      expect(hoverCard).not.toBeNull();
      const hoverMarkers = Array.from(hoverCard!.querySelectorAll("[data-hover-marker]")).map(
        (node) => node.getAttribute("data-hover-marker"),
      );
      expect(hoverMarkers).toEqual([
        "pr",
        "machineOffline",
        "draft",
        "queued",
        "scheduled",
        "pinned",
        "machine",
        "project",
        "tags",
        "color",
        "notifications",
        "provider",
      ]);
    });
  });

  it("enforces PR over offline machine, and offline machine over draft", async () => {
    using env = setup();
    const prThreadId = ThreadId.make("thread-pr-offline");
    const offlineThreadId = ThreadId.make("thread-offline-draft");
    mockConnectionByEnvironmentId.set(remoteEnvId, {
      environmentId: remoteEnvId,
      environmentLabel: "Remote box",
      connectionState: "offline",
      lastSeenAt: Date.parse("2026-11-27T00:00:00.000Z"),
    });
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(remoteEnvId, offlineThreadId), "Draft text");

    const prThread = makeShell(remoteEnvId, {
      id: prThreadId,
      title: "PR thread",
      pullRequests: [makePrLink(7, "PR thread")],
    });
    const offlineThread = makeShell(remoteEnvId, {
      id: offlineThreadId,
      title: "Offline draft thread",
    });

    await using screen = await render(
      <RegistryContext.Provider value={env.registry}>
        <TooltipProvider delay={0}>
          <ul>
            <SortableThreadRow {...makeRowProps({ thread: prThread })} />
            <SortableThreadRow {...makeRowProps({ thread: offlineThread })} />
          </ul>
        </TooltipProvider>
      </RegistryContext.Provider>,
    );

    const rows = screen.container.querySelectorAll('[data-testid="sidebar-row-card"]');
    expect(rows).toHaveLength(2);
    expect(
      Array.from(rows[0]!.querySelectorAll("[data-row-marker]")).map((node) =>
        node.getAttribute("data-row-marker"),
      ),
    ).toEqual(["pr"]);
    expect(
      Array.from(rows[1]!.querySelectorAll("[data-row-marker]")).map((node) =>
        node.getAttribute("data-row-marker"),
      ),
    ).toEqual(["machineOffline"]);
  });

  it("suppresses the machine badge when grouped by machine and the project badge when grouped by project", async () => {
    using env = setup();
    const thread = makeShell(remoteEnvId, {
      id: ThreadId.make("thread-grouped"),
      title: "Grouped row",
      tags: ["backend"],
    });

    await using screen = await render(
      <RegistryContext.Provider value={env.registry}>
        <TooltipProvider delay={0}>
          <ul>
            <SortableThreadRow
              {...makeRowProps({
                thread,
                variant: "folder",
                inMachineFolder: true,
                inProjectFolder: false,
              })}
            />
            <SortableThreadRow
              {...makeRowProps({
                thread,
                variant: "folder",
                inMachineFolder: true,
                inProjectFolder: true,
              })}
            />
          </ul>
        </TooltipProvider>
      </RegistryContext.Provider>,
    );

    const rows = screen.container.querySelectorAll('[data-testid="sidebar-row-folder"]');
    expect(rows).toHaveLength(2);
    // Grouped by machine only -> machine badge suppressed, next priority marker is project.
    expect(
      Array.from(rows[0]!.querySelectorAll("[data-row-marker]")).map((node) =>
        node.getAttribute("data-row-marker"),
      ),
    ).toEqual(["project"]);
    // Grouped by machine + project -> both badges suppressed, next priority marker is tags.
    expect(
      Array.from(rows[1]!.querySelectorAll("[data-row-marker]")).map((node) =>
        node.getAttribute("data-row-marker"),
      ),
    ).toEqual(["tags"]);
  });

  it("renders failed directly in the marker slot on slim rows that have no status slot", async () => {
    using env = setup();
    const thread = makeShell(localEnvId, {
      id: ThreadId.make("thread-slim-failed"),
      title: "Slim failed",
      status: "failed",
      latestRunId: RunId.make("run-failed"),
      lastError: "Process exited",
    });

    await using screen = await render(
      <RegistryContext.Provider value={env.registry}>
        <TooltipProvider delay={0}>
          <ul>
            <SortableThreadRow
              {...makeRowProps({
                thread,
                variant: "slim",
                variantAction: "unsettle",
              })}
            />
          </ul>
        </TooltipProvider>
      </RegistryContext.Provider>,
    );

    const row = screen.getByTestId("sidebar-row-slim");
    await expect.element(row).toBeVisible();
    expect(
      Array.from(row.element().querySelectorAll("[data-row-marker]")).map((node) =>
        node.getAttribute("data-row-marker"),
      ),
    ).toEqual(["failed"]);
  });
});
