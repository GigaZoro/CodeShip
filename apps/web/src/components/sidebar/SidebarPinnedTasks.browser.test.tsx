import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { dismissContextMenu } from "../../contextMenuFallback";
import { ThreadFolderNameDialogHost } from "../ThreadFolderNameDialog";
import { SidebarPinnedTasksBlock } from "./SidebarPinnedTasks";

const environmentId = EnvironmentId.make("laptop");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("review"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
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
  placement: "pinned",
  pinOrderKey: "a0",
  group: null,
};
const tasks = Atom.make(AsyncResult.success<ScheduledTaskListResult>({ tasks: [] }));
const canWrite = Atom.make(true);
const savedFolders = Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive);

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: () => tasks,
      setScheduledTaskPlacement: {
        ...actual.serverEnvironment.setScheduledTaskPlacement,
        permissionAtom: () => canWrite,
      },
      setScheduledTaskGroup: {
        ...actual.serverEnvironment.setScheduledTaskGroup,
        permissionAtom: () => canWrite,
        run: async (registry, { input }) => {
          registry.update(tasks, ({ value }) =>
            AsyncResult.success({
              ...value,
              tasks: value.tasks.map((entry) =>
                entry.id === input.id ? { ...entry, group: input.group } : entry,
              ),
            }),
          );
          return AsyncResult.success(undefined);
        },
      },
    },
  };
});

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadEnvironment: {
      ...actual.threadEnvironment,
      savedFoldersAtom: () => savedFolders,
      saveFolders: {
        ...actual.threadEnvironment.saveFolders,
        permissionAtom: () => canWrite,
        run: async (registry, { input: { folders } }) => {
          registry.set(savedFolders, folders);
          return AsyncResult.success({ folders });
        },
      },
    },
  };
});

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({
    connection: { phase: "connected" },
    serverConfig: {
      environment: { capabilities: { scheduledTaskSetGroup: true, threadFolders: true } },
    },
  })) as never,
}));

it("creates a folder from the Scheduled context menu and preserves pin order when moving another task into it", async () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  registry.set(
    tasks,
    AsyncResult.success({
      tasks: [
        {
          ...task,
          id: ScheduledTaskId.make("audit"),
          title: "Audit changes",
          pinOrderKey: "a1",
        },
        task,
      ],
    }),
  );
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ul role="tree" aria-label="Sidebar">
        <SidebarPinnedTasksBlock
          environmentIdsKey={JSON.stringify([environmentId])}
          scopedProjectKeys={null}
          projectDisplayNameByKey={new Map()}
          environmentLabelById={new Map()}
          environmentMachineById={new Map()}
          routeThreadKey={null}
          onNavigateToThread={vi.fn()}
        />
      </ul>
      <ThreadFolderNameDialogHost />
    </RegistryContext.Provider>,
  );
  using _menu = { [Symbol.dispose]: () => dismissContextMenu(false) };

  await screen.getByRole("treeitem", { name: /^Audit changes/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  const folderMenu = page.getByRole("menu", { name: "Move to folder" });
  await folderMenu.getByRole("menuitem", { name: "New folder…" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByRole("textbox", { name: "Folder name" }).fill("Maintenance");
  await dialog.getByRole("button", { name: "Create folder" }).click();
  await vi.waitFor(() => expect(registry.get(savedFolders)).toEqual(["Maintenance"]));

  await screen.getByRole("treeitem", { name: /^Review issues/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  await folderMenu.getByRole("menuitemradio", { name: "Maintenance" }).click();

  const folder = screen.getByRole("treeitem", { name: /^Maintenance/ });
  await folder.click();
  await expect
    .element(screen.getByRole("treeitem", { name: /^Review issues/ }))
    .not.toBeInTheDocument();
  await folder.click();
  const pinnedRows = screen.getByRole("treeitem", { name: /^(Review issues|Audit changes)/ });
  await expect.element(pinnedRows.first()).toHaveAccessibleName(/^Review issues/);
  await expect.element(pinnedRows.last()).toHaveAccessibleName(/^Audit changes/);
});
