import { act, render } from "../../test/render";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProjectScriptExistsError,
  type ProjectScript,
  type ProjectScriptMutation,
  type ResolvedKeybindingsConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  projectScriptIdsInSettings,
  projectScriptMutationPatch,
} from "@t3tools/shared/projectScripts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { ProjectScriptShortcutError, type NewProjectScriptInput } from "./projectScriptEditor";

const state = vi.hoisted(() => ({
  /** What the client last received; the tests leave it stale while the server moves on. */
  clientSettings: null as unknown as ServerSettings,
  serverSettings: null as unknown as ServerSettings,
  keybindings: [] as ResolvedKeybindingsConfig,
}));
const commands = vi.hoisted(() => ({
  updateProjectScripts: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () =>
        Atom.make(() => ({
          settings: state.clientSettings,
          keybindings: state.keybindings,
          environment: { capabilities: { projectScriptMutations: true } },
        })),
      updateProjectScripts: "updateProjectScripts",
      upsertKeybinding: "upsertKeybinding",
      removeKeybinding: "removeKeybinding",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: keyof typeof commands) => commands[command]) as never,
}));

import { useSaveProjectScripts } from "./useSaveProjectScripts";

const environmentId = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const lint: ProjectScript = {
  id: "lint",
  name: "Lint",
  command: "vp lint",
  icon: "lint",
  runOnWorktreeCreate: false,
};
const lintBinding: ResolvedKeybindingsConfig = [
  {
    command: "script.lint.run",
    shortcut: {
      key: "k",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    },
  },
];
const input: NewProjectScriptInput = {
  name: lint.name,
  command: lint.command,
  icon: lint.icon,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  previewUrl: null,
  autoOpenPreview: false,
};

type SaveProjectScripts = ReturnType<typeof useSaveProjectScripts>;

function Probe(props: { onResult: (save: SaveProjectScripts) => void }) {
  props.onResult(useSaveProjectScripts());
  return null;
}

/** Applies each change to its own settings as the server does under its write lock. */
function serveProjectScripts({ input: mutation }: { input: ProjectScriptMutation }) {
  if (
    mutation.operation === "add" &&
    projectScriptIdsInSettings(state.serverSettings).has(mutation.script.id)
  ) {
    return Promise.resolve(
      AsyncResult.failure(
        Cause.fail(new ProjectScriptExistsError({ scriptId: mutation.script.id })),
      ),
    );
  }
  state.serverSettings = applyServerSettingsPatch(
    state.serverSettings,
    projectScriptMutationPatch(state.serverSettings, mutation),
  );
  return Promise.resolve(AsyncResult.success(state.serverSettings));
}

function setup(settings: Partial<ServerSettings>, keybindings: ResolvedKeybindingsConfig = []) {
  vi.clearAllMocks();
  state.clientSettings = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true, ...settings };
  state.serverSettings = state.clientSettings;
  state.keybindings = keybindings;
  commands.updateProjectScripts.mockImplementation(serveProjectScripts);
  commands.upsertKeybinding.mockResolvedValue(AsyncResult.success(undefined));
  commands.removeKeybinding.mockResolvedValue(AsyncResult.success(undefined));
}

async function renderSave() {
  let save: SaveProjectScripts | undefined;
  const screen = await render(<Probe onResult={(next) => (save = next)} />);
  return {
    ...screen,
    async run(...args: Parameters<SaveProjectScripts>) {
      let result: Awaited<ReturnType<SaveProjectScripts>> | undefined;
      await act(async () => {
        result = await save!(...args);
      });
      return result!;
    },
  };
}

describe("useSaveProjectScripts", () => {
  it.each([projectId, null])(
    "preserves the shortcut for name and command edits in list %s",
    async (listProjectId) => {
      setup(
        listProjectId === null
          ? { defaultProjectScripts: [lint] }
          : { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [lint] } } },
        lintBinding,
      );
      await using screen = await renderSave();
      const changes = { name: "Lint and fix", command: "vp lint --fix" };

      const result = await screen.run([{ environmentId, projectId: listProjectId }], {
        kind: "save",
        scriptId: lint.id,
        input: { ...input, ...changes },
      });

      expect(result._tag).toBe("Success");
      expect(commands.updateProjectScripts).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          operation: "upsert",
          projectId: listProjectId,
          script: expect.objectContaining({ id: lint.id, ...changes }),
        },
      });
      expect(commands.removeKeybinding).not.toHaveBeenCalled();
      expect(commands.upsertKeybinding).not.toHaveBeenCalled();
    },
  );

  it("reports a shortcut failure after the action was saved as an edit of that action", async () => {
    setup({ projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [lint] } } });
    commands.upsertKeybinding.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Offline."))),
    );
    await using screen = await renderSave();

    const result = await screen.run([{ environmentId, projectId }], {
      kind: "save",
      scriptId: lint.id,
      input: { ...input, keybinding: "mod+j" },
    });

    const error = result._tag === "Failure" ? Cause.squash(result.cause) : null;
    expect(error).toBeInstanceOf(ProjectScriptShortcutError);
    expect(error).toMatchObject({ scriptId: lint.id });
  });

  it("keeps both actions when two are added before the list re-renders", async () => {
    setup({ defaultProjectScripts: [lint] });
    await using screen = await renderSave();
    const add = (name: string, command: string) =>
      screen.run([{ environmentId, projectId }], {
        kind: "save",
        scriptId: null,
        input: { ...input, name, command },
      });

    expect((await add("Dev", "vp run dev"))._tag).toBe("Success");
    expect((await add("Test", "vp test"))._tag).toBe("Success");

    expect(
      state.serverSettings.projectSettingsOverrides[projectId]?.defaultProjectScripts?.map(
        (script) => script.id,
      ),
    ).toEqual(["lint", "dev", "test"]);
  });
});
