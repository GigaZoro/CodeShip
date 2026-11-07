import { act, render, type Screen } from "../../test/render";
import {
  EnvironmentId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));

import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  ProjectScriptEditorDialog,
  ProjectScriptShortcutError,
  type ProjectScriptActionResult,
  type ProjectScriptEditorRequest,
} from "./projectScriptEditor";

const onSubmit = vi.fn<Parameters<typeof ProjectScriptEditorDialog>[0]["onSubmit"]>();
const onClose = vi.fn();
const onDelete = vi.fn();

function request(name: string, error?: string): ProjectScriptEditorRequest {
  return {
    scriptId: name,
    initial: { ...EMPTY_PROJECT_SCRIPT_INPUT, name, command: `run-${name}` },
    ...(error === undefined ? {} : { error }),
  };
}

const addRequest = (name: string): ProjectScriptEditorRequest => ({
  ...request(name),
  scriptId: null,
});

const open = (
  screen: Screen,
  nextRequest: ProjectScriptEditorRequest,
  options: {
    scripts?: ReadonlyArray<ProjectScript>;
    keybindings?: ResolvedKeybindingsConfig;
  } = {},
) =>
  screen.rerender(
    <StrictMode>
      <ProjectScriptEditorDialog
        environmentId={EnvironmentId.make("test")}
        request={nextRequest}
        scripts={options.scripts ?? []}
        keybindings={options.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS}
        onSubmit={onSubmit}
        onClose={onClose}
        onDelete={onDelete}
      />
    </StrictMode>,
  );

const submit = () => document.querySelector("form")!.requestSubmit();
const saveButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const keybindingField = () => document.querySelector<HTMLInputElement>("#script-keybinding")!;

function deferredSave() {
  let resolve!: (result: ProjectScriptActionResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ProjectScriptActionResult>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  return { promise, resolve, reject };
}

function setup() {
  onSubmit.mockReset();
  onClose.mockReset();
  onDelete.mockReset();
}

describe("project action editor save lifecycle", () => {
  it("does not close a replacement request or release its in-flight save", async () => {
    setup();
    await using screen = await render(null);
    const first = deferredSave();
    const second = deferredSave();
    onSubmit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await open(screen, request("test"));
    expect(saveButton().disabled).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#script-name")!.value).toBe("test");
    await act(async () => submit());

    await act(async () => first.resolve(AsyncResult.success(undefined)));
    expect(onClose).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);

    await act(async () => second.resolve(AsyncResult.success(undefined)));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual(["build", "test"]);
  });

  it("cannot be dismissed while a save is in flight", async () => {
    setup();
    await using screen = await render(null);
    const save = deferredSave();
    onSubmit.mockReturnValueOnce(save.promise);
    await open(screen, request("build"));
    await act(async () => submit());

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => save.resolve(AsyncResult.success(undefined)));
  });

  it("edits the added action when only its shortcut failed to save", async () => {
    setup();
    await using screen = await render(null);
    onSubmit
      .mockResolvedValueOnce(
        AsyncResult.failure(Cause.fail(new ProjectScriptShortcutError("build", "Offline."))),
      )
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    await open(screen, addRequest("build"));
    await act(async () => submit());
    await act(async () => submit());

    expect(onSubmit.mock.calls.map(([scriptId]) => scriptId)).toEqual([null, "build"]);
  });

  it("rejects a name another action already uses", async () => {
    setup();
    await using screen = await render(null);
    const test: ProjectScript = {
      id: "test",
      name: "Test",
      command: "vp test",
      icon: "test",
      runOnWorktreeCreate: false,
    };
    await open(screen, addRequest("test "), { scripts: [test] });
    await act(async () => submit());

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent('An action named "test" already exists.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("names the saved action in the delete confirmation", async () => {
    setup();
    await using screen = await render(null);
    await open(screen, request("build"));
    await userEvent.fill(page.getByLabelText("Name"), "renamed");
    // The modal's inert layer covers the popup in tests, which load no app styles.
    await act(async () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "Delete")!
        .click(),
    );

    await expect
      .element(page.getByRole("alertdialog").getByRole("heading"))
      .toHaveTextContent('Delete action "build"?');
  });
});

describe("project action editor shortcut field", () => {
  it("leaves plain keys to the form so Enter saves", async () => {
    setup();
    await using screen = await render(null);
    onSubmit.mockResolvedValueOnce(AsyncResult.success(undefined));
    await open(screen, request("build"));
    await userEvent.click(keybindingField());
    await userEvent.keyboard("b{Enter}");

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      "build",
      expect.not.objectContaining({ keybinding: expect.anything() }),
    );
  });

  it("does not save a shortcut another command uses", async () => {
    setup();
    await using screen = await render(null);
    await open(screen, request("build"), {
      keybindings: [
        {
          command: "script.lint.run",
          shortcut: {
            key: "j",
            metaKey: false,
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            modKey: false,
          },
        },
      ],
    });
    await userEvent.click(keybindingField());
    await userEvent.keyboard("{Control>}j{/Control}");
    await act(async () => submit());

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Conflicts with Run Script: Lint.");
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
