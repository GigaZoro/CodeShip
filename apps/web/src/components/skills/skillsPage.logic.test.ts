import { EnvironmentId, type ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildSkillsView, type SkillsSearch, validateSkillsSearch } from "./skillsPage.logic";

const skill = (name: string, scope = "user"): ServerProviderSkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  scope,
  enabled: true,
});

const mac = { environmentId: EnvironmentId.make("mac"), label: "Mac" };
const pc = { environmentId: EnvironmentId.make("pc"), label: "PC" };

function view(search: SkillsSearch = {}) {
  return buildSkillsView({
    machines: [
      {
        machine: mac,
        agents: [
          {
            key: "claude",
            provider: "Claude",
            skills: [skill("plan"), skill("review"), skill("deploy", "project")],
          },
          { key: "codex", provider: "Codex", skills: [skill("lint")] },
        ],
      },
      {
        machine: pc,
        agents: [{ key: "claude", provider: "Claude", skills: [skill("Review")] }],
      },
    ],
    search,
  });
}

const missingByName = (result: ReturnType<typeof view>, label: string) =>
  Object.fromEntries(
    result.columns
      .find((column) => column.machine.label === label)!
      .groups.flatMap((group) => group.skills)
      .map((row) => [row.skill.name, row.missingOn.map((machine) => machine.label)]),
  );

describe("buildSkillsView", () => {
  it("flags machine-wide skills that the same agent lacks on another shown machine", () => {
    expect(missingByName(view(), "Mac")).toEqual({
      plan: ["PC"],
      review: [],
      // Project skills follow the checkout, and PC has no Codex to compare with.
      deploy: [],
      lint: [],
    });
  });

  it("narrows to differences, and stops comparing once one machine is left", () => {
    const differences = view({ missing: true });
    expect(differences.shown).toBe(1);
    expect(missingByName(differences, "Mac")).toEqual({ plan: ["PC"] });

    const macOnly = view({ missing: true, hideMachine: ["pc"] });
    expect(macOnly.comparing).toBe(false);
    expect(macOnly.columns.map((column) => column.machine.label)).toEqual(["Mac"]);
    expect(macOnly.shown).toBe(4);
  });
});

describe("validateSkillsSearch", () => {
  it("keeps known filters and drops malformed ones", () => {
    expect(
      validateSkillsSearch({
        q: "  ",
        status: "broken",
        hideAgent: ["codex", "codex", 3],
        hideSource: ["personal", "nope"],
        hideMachine: "pc",
        missing: "true",
      }),
    ).toEqual({ hideAgent: ["codex"], hideSource: ["personal"] });
  });
});
