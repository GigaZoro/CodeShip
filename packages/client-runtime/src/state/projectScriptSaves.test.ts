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
  type ProjectScriptInput,
} from "@t3tools/shared/projectScripts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ProjectScriptShortcutError,
  saveProjectScripts,
  type ProjectScriptSaveContext,
} from "./projectScriptSaves.ts";
import type { AtomCommandResult } from "./runtime.ts";

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
const input: ProjectScriptInput = {
  name: lint.name,
  command: lint.command,
  icon: lint.icon,
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  previewUrl: null,
  autoOpenPreview: false,
};

/**
 * A server that applies each change to its own settings under its write lock, while the client
 * keeps the settings it last received.
 */
function setup(settings: Partial<ServerSettings>, keybindings: ResolvedKeybindingsConfig = []) {
  const clientSettings = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true, ...settings };
  const server = { settings: clientSettings };
  const updateProjectScripts = vi.fn(
    ({
      input: mutation,
    }: {
      readonly input: ProjectScriptMutation;
    }): Promise<AtomCommandResult<ServerSettings, unknown>> => {
      if (
        mutation.operation === "add" &&
        projectScriptIdsInSettings(server.settings).has(mutation.script.id)
      ) {
        return Promise.resolve(
          AsyncResult.failure(
            Cause.fail(new ProjectScriptExistsError({ scriptId: mutation.script.id })),
          ),
        );
      }
      server.settings = applyServerSettingsPatch(
        server.settings,
        projectScriptMutationPatch(server.settings, mutation),
      );
      return Promise.resolve(AsyncResult.success(server.settings));
    },
  );
  const succeed = (): Promise<AtomCommandResult<unknown, unknown>> =>
    Promise.resolve(AsyncResult.success(undefined));
  const upsertKeybinding = vi.fn(succeed);
  const removeKeybinding = vi.fn(succeed);
  const context: ProjectScriptSaveContext = {
    config: () => ({
      settings: clientSettings,
      keybindings,
      environment: { capabilities: { projectScriptMutations: true } } as never,
    }),
    projects: () => [],
    canWriteSettings: () => true,
    updateProjectScripts,
    upsertKeybinding,
    removeKeybinding,
  };
  return { context, server, updateProjectScripts, upsertKeybinding, removeKeybinding };
}

const listIds = (settings: ServerSettings, id: ProjectId) =>
  settings.projectSettingsOverrides[id]?.defaultProjectScripts?.map((script) => script.id);

describe("saveProjectScripts", () => {
  it.each([projectId, null])(
    "preserves the shortcut for name and command edits in list %s",
    async (listProjectId) => {
      const { context, updateProjectScripts, upsertKeybinding, removeKeybinding } = setup(
        listProjectId === null
          ? { defaultProjectScripts: [lint] }
          : { projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [lint] } } },
        lintBinding,
      );
      const changes = { name: "Lint and fix", command: "vp lint --fix" };

      const result = await saveProjectScripts(
        context,
        [{ environmentId, projectId: listProjectId }],
        { kind: "save", scriptId: lint.id, input: { ...input, ...changes } },
      );

      expect(result._tag).toBe("Success");
      expect(updateProjectScripts).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          operation: "upsert",
          projectId: listProjectId,
          script: expect.objectContaining({ id: lint.id, ...changes }),
        },
      });
      expect(removeKeybinding).not.toHaveBeenCalled();
      expect(upsertKeybinding).not.toHaveBeenCalled();
    },
  );

  it("reports a shortcut failure after the action was saved as an edit of that action", async () => {
    const { context, upsertKeybinding } = setup({
      projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [lint] } },
    });
    upsertKeybinding.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Offline."))));

    const result = await saveProjectScripts(context, [{ environmentId, projectId }], {
      kind: "save",
      scriptId: lint.id,
      input: { ...input, keybinding: "mod+j" },
    });

    const error = result._tag === "Failure" ? Cause.squash(result.cause) : null;
    expect(error).toBeInstanceOf(ProjectScriptShortcutError);
    expect(error).toMatchObject({ scriptId: lint.id });
  });

  it("keeps both actions when two are added before the list re-renders", async () => {
    const { context, server } = setup({ defaultProjectScripts: [lint] });
    const add = (name: string, command: string) =>
      saveProjectScripts(context, [{ environmentId, projectId }], {
        kind: "save",
        scriptId: null,
        input: { ...input, name, command },
      });

    expect((await add("Dev", "vp run dev"))._tag).toBe("Success");
    expect((await add("Test", "vp test"))._tag).toBe("Success");

    expect(listIds(server.settings, projectId)).toEqual(["lint", "dev", "test"]);
  });

  it("adds a new action to every checkout of the project on one environment", async () => {
    const otherCheckout = ProjectId.make("other-checkout");
    const { context, server } = setup({});

    const result = await saveProjectScripts(
      context,
      [
        { environmentId, projectId },
        { environmentId, projectId: otherCheckout },
      ],
      { kind: "save", scriptId: null, input },
    );

    expect(result._tag).toBe("Success");
    expect([listIds(server.settings, projectId), listIds(server.settings, otherCheckout)]).toEqual([
      ["lint"],
      ["lint"],
    ]);
  });
});
