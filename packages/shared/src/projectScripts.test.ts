import { DEFAULT_SERVER_SETTINGS, ProjectId, type ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProjectScriptChange,
  commandForProjectScript,
  decodeProjectScriptKeybindingRule,
  nextProjectScriptId,
  primaryProjectScript,
  PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
  projectScriptIdsInUse,
  settleProjectScript,
  setupProjectScript,
} from "./projectScripts.ts";

describe("projectScripts helpers", () => {
  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");

    // Shortcuts are keyed by id environment-wide, so ids used by other projects or bound to a
    // shortcut are taken too.
    const script = (id: string): ProjectScript => ({
      id,
      name: id,
      command: id,
      icon: "play",
      runOnWorktreeCreate: false,
    });
    const idsInUse = projectScriptIdsInUse({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [ProjectId.make("other")]: { defaultProjectScripts: [script("build")] },
        },
      },
      projects: [{ id: ProjectId.make("current"), scripts: [] }],
      keybindings: [{ command: "script.lint.run" }],
    });
    expect(nextProjectScriptId("Build", idsInUse)).toBe("build-2");
    expect(nextProjectScriptId("Lint", idsInUse)).toBe("lint-2");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };
    const saved = (roles: { runOnWorktreeCreate: boolean; runOnSettle: boolean }) =>
      applyProjectScriptChange([holder], {
        operation: "add",
        projectId: null,
        script: { id: "next", name: "Next", command: "true", icon: "play", ...roles },
      })[0];

    expect(saved({ runOnWorktreeCreate: false, runOnSettle: true })).toMatchObject({
      runOnWorktreeCreate: true,
      runOnSettle: false,
    });
    expect(saved({ runOnWorktreeCreate: true, runOnSettle: false })).toMatchObject({
      runOnWorktreeCreate: false,
      runOnSettle: true,
    });
    expect(saved({ runOnWorktreeCreate: false, runOnSettle: false })).toBe(holder);
  });

  it("can edit or delete a legacy script without a shortcut", () => {
    const command = commandForProjectScript("install-javascript-dependencies");
    expect(decodeProjectScriptKeybindingRule({ keybinding: null, command })).toBeNull();
    expect(() => decodeProjectScriptKeybindingRule({ keybinding: "mod+k", command })).toThrowError(
      PROJECT_SCRIPT_KEYBINDING_INVALID_MESSAGE,
    );
  });
});
