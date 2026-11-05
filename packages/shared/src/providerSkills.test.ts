import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveAvailableProviderSkills } from "./providerSkills.ts";

const skill = (name: string, enabled = true) => ({ name, enabled, path: `/${name}/SKILL.md` });
const provider = (id: string, skills: ServerProvider["skills"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  enabled: true,
  installed: true,
  version: "1.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-05T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills,
});

describe("resolveAvailableProviderSkills", () => {
  it("shares only eligible skills from the current workspace and preserves native overrides", () => {
    const native = provider("codex", [skill("review"), skill("off", false)]);
    const peer = provider("claudeAgent", [
      skill("REVIEW"),
      skill("off"),
      skill("foreign"),
      skill("disabled", false),
      { ...skill("agent-only"), userInvocable: false },
      { ...skill("other-project"), scope: "project" },
    ]);
    const otherWorkspace = [
      {
        cwd: "/other",
        checkedAt: native.checkedAt,
        slashCommands: [],
        skills: [skill("other")],
      },
    ];
    const input = {
      providers: [
        { ...peer, workspaceSnapshots: otherWorkspace },
        native,
        { ...provider("cursor", [skill("hidden")]), enabled: false },
      ],
      instanceId: native.instanceId,
      cwd: "/workspace",
    };
    expect(resolveAvailableProviderSkills({ ...input, availability: "provider" })).toBe(
      native.skills,
    );
    expect(resolveAvailableProviderSkills({ ...input, availability: "shared" })).toEqual([
      ...native.skills,
      skill("foreign"),
    ]);
    const currentWorkspace = [
      {
        cwd: input.cwd,
        checkedAt: native.checkedAt,
        slashCommands: [],
        skills: [{ ...skill("workspace-skill"), scope: "project" }],
      },
    ];
    const scopedInput = {
      ...input,
      providers: [{ ...peer, workspaceSnapshots: currentWorkspace }, native],
    };
    expect(resolveAvailableProviderSkills({ ...scopedInput, availability: "shared" })).toEqual([
      ...native.skills,
      { ...skill("workspace-skill"), scope: "project" },
    ]);
    expect(
      resolveAvailableProviderSkills({
        ...scopedInput,
        instanceId: peer.instanceId,
        availability: "shared",
      }).map((entry) => entry.name),
    ).toEqual(["workspace-skill", "review"]);
  });
});
