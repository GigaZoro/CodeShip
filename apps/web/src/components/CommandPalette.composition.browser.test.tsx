import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../state/server";
import { EnvironmentId, ThreadId, type ServerConfig } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useActiveThreadPaletteItems } from "./CommandPaletteThreadActions";
import { Atom } from "effect/reactivity";
import { environmentThreadShells } from "../state/threads";

const environmentId = EnvironmentId.make("local");
const thread = {
  id: ThreadId.make("thread"),
  environmentId,
  title: "Thread",
  runtime: null,
  notificationLevel: "muted",
  color: "blue",
} as unknown as EnvironmentThreadShell;

const preferences = vi.hoisted(() => ({
  canSet: false,
  threadColor: false,
  threadNotificationLevel: false,
}));
function setupPreferences(options: typeof preferences) {
  Object.assign(preferences, options);
}
const preferencePermission = Atom.make(false);
vi.mock("../state/threads", async (original) => {
  const module = await original<typeof import("../state/threads")>();
  return {
    ...module,
    threadEnvironment: {
      ...module.threadEnvironment,
      setPreferences: {
        ...module.threadEnvironment.setPreferences,
        permissionAtom: () => preferencePermission,
      },
    },
  };
});

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom
      ? DEFAULT_RESOLVED_KEYBINDINGS
      : atom === environmentThreadShells.needsYouThreadsAtom
        ? { threads: [] }
        : atom === environmentServerConfigsAtom
          ? new Map([
              [
                environmentId,
                {
                  environment: {
                    capabilities: {
                      threadColor: preferences.threadColor,
                      threadNotificationLevel: preferences.threadNotificationLevel,
                    },
                  },
                } as unknown as ServerConfig,
              ],
            ])
          : atom === preferencePermission
            ? preferences.canSet
            : [],
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateEnvironmentSettings: () => () => undefined,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useVisibleThreadShells: () => [],
  useHiddenThreadKeys: () => new Set(),
  useAnyEnvironmentHiding: () => false,
  useEnvironmentThreadRefs: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    setupPreferences({ canSet: false, threadColor: false, threadNotificationLevel: false });
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(step === "folder" ? "Local folder" : "Git URL", { exact: true }).click();
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

function ActiveThreadActions() {
  return (
    <ul>
      {useActiveThreadPaletteItems(thread).map((item) => (
        <li key={item.value}>{item.title}</li>
      ))}
    </ul>
  );
}

it.each([
  { canSet: true, threadColor: true, threadNotificationLevel: true },
  { canSet: true, threadColor: false, threadNotificationLevel: true },
  { canSet: false, threadColor: true, threadNotificationLevel: true },
])("shows reset choices when the destination supports and authorizes them: %j", async (options) => {
  setupPreferences(options);
  await using screen = await render(<ActiveThreadActions />);
  expect(screen.getByText("Notifications: Default").query() !== null).toBe(
    options.canSet && options.threadNotificationLevel,
  );
  expect(screen.getByText("Color: None").query() !== null).toBe(
    options.canSet && options.threadColor,
  );
});
