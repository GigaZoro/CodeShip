import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ThreadFolderNameDialogHost } from "../ThreadFolderNameDialog";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Saved where the target supported checks and prompt files; the test target supports neither.
const checkedTask: ScheduledTask = {
  ...task,
  runCondition: { command: "node ~/has-work.mjs", timeoutSeconds: 90 },
  promptFile: { path: "prompts/nightly.md", lastRead: null },
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  checked: false,
  describes: false,
}));
// The web build runs the React Compiler, so a memoized form re-renders only when a hook it calls
// changes. The environment mocks read the connection through this store, as the real hooks
// subscribe to theirs; a plain flag and a rerender would leave the form showing the old target.
const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (connected: boolean) => {
      state.connected = connected;
      for (const listener of listeners) listener();
    },
  };
});
const useConnected = () => useSyncExternalStore(connection.subscribe, () => state.connected);
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();
const savedFolders = Atom.family((_id: EnvironmentId) => Atom.make<ReadonlyArray<string>>([]));

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  state.checked = false;
  state.describes = false;
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? {
          environment: {
            platform: "linux",
            capabilities: {
              oneTimeSchedules: true,
              scheduledTaskGroups: true,
              threadFolders: true,
              ...(state.describes ? { scheduledTaskDescriptions: true } : {}),
            },
          },
        }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    useConnected();
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      groups: [],
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
    threadEnvironment: {
      ...actual.threadEnvironment,
      savedFoldersAtom: (id) => savedFolders(id),
      saveFolders: {
        ...actual.threadEnvironment.saveFolders,
        permissionAtom: (id) => permissions.get(id ?? "")!,
        run: async (registry, { environmentId, input: { folders } }) => {
          registry.set(savedFolders(environmentId), folders);
          return AsyncResult.success({ folders });
        },
      },
    },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : { tasks: state.tasksLoaded ? [state.checked ? checkedTask : task] : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) => {
    useConnected();
    return id === secondaryId ? secondaryEnvironment() : environment();
  }) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("creates a folder from the empty scheduled tasks list", async () => {
    setup();
    state.tasksLoaded = false;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
        <ThreadFolderNameDialogHost />
      </RegistryContext.Provider>,
    );

    await screen.getByRole("button", { name: "New folder…" }).click();
    const dialog = page.getByRole("dialog", { name: "New folder" });
    await userEvent.fill(dialog.getByRole("textbox", { name: "Folder name" }), "Maintenance");
    await dialog.getByRole("button", { name: "Create folder" }).click();

    await expect.element(screen.getByText("Maintenance", { exact: true })).toBeVisible();
  });

  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New task" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Secondary");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New task" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New task" })).toBeDisabled();
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");
    const save = page.getByRole("dialog").getByRole("button", { name: "Save task" });
    await expect.element(save).toBeEnabled();

    await act(() => connection.set(false));

    await expect.element(save).toBeDisabled();
    await expect.element(name).toHaveValue("Review stale issues");

    await act(() => connection.set(true));
    await expect.element(save).toBeEnabled();
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("says a target is older only while its config is known", async () => {
    setup();
    state.checked = true;
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const dialog = page.getByRole("dialog");
    await expect
      .element(dialog.getByText(/Laptop runs an older T3.CodeShip that cannot run checks/))
      .toBeVisible();
    await expect
      .element(
        dialog.getByText(/Laptop runs an older T3.CodeShip that cannot read prompts from files/),
      )
      .toBeVisible();

    await act(() => connection.set(false));

    await expect.element(dialog.getByRole("button", { name: "Save task" })).toBeDisabled();
    await expect
      .element(dialog.getByRole("textbox", { name: "Name" }))
      .toHaveValue("Review issues");
    await expect.element(dialog.getByText(/older T3.CodeShip/)).not.toBeInTheDocument();
    await expect
      .element(dialog.getByRole("textbox", { name: "Prompt", exact: true }))
      .toHaveValue("prompts/nightly.md");

    await act(() => connection.set(true));
    await expect
      .element(dialog.getByText(/Laptop runs an older T3.CodeShip that cannot run checks/))
      .toBeVisible();
  });

  it("keeps an unsaved description without a verdict while the target is unknown", async () => {
    setup();
    state.describes = true;
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const dialog = page.getByRole("dialog");
    const description = dialog.getByRole("textbox", { name: "Description (optional)" });
    await userEvent.fill(description, "Nightly review");
    await expect
      .element(dialog.getByText("A short summary shown in the scheduled task list."))
      .toBeVisible();

    await act(() => connection.set(false));

    await expect.element(dialog.getByRole("button", { name: "Save task" })).toBeDisabled();
    await expect.element(description).toHaveValue("Nightly review");
    await expect.element(dialog.getByText(/cannot save descriptions/)).not.toBeInTheDocument();

    // A known target without description support still gets the verdict for the same edit.
    state.describes = false;
    await act(() => connection.set(true));
    await expect.element(dialog.getByText(/Laptop cannot save descriptions/)).toBeVisible();
    await expect.element(description).toHaveValue("Nightly review");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });
});
