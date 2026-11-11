import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import {
  accountGroups,
  reviewGuideModelInheritance,
  scheduledTaskModelInheritance,
  sourceControlWriterModelInheritance,
} from "./modelsSettings.logic";

const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5");

describe("model role inheritance", () => {
  it("lets scheduled tasks follow the default until they pick a model", () => {
    expect(scheduledTaskModelInheritance({ scheduledTaskModelSelection: null })?.from).toBe(
      "default",
    );
    expect(scheduledTaskModelInheritance({ scheduledTaskModelSelection: selection })).toBeNull();
  });

  it("lets commit and pull request writing follow the titles model", () => {
    expect(
      sourceControlWriterModelInheritance({ sourceControlWriterModelSelection: null })?.from,
    ).toBe("titles");
    expect(
      sourceControlWriterModelInheritance({ sourceControlWriterModelSelection: selection }),
    ).toBeNull();
  });

  it("names the role a review guide actually follows", () => {
    const unset = { reviewGuideModelSelection: null, sourceControlWriterModelSelection: null };
    expect(reviewGuideModelInheritance(unset)?.from).toBe("titles");
    expect(
      reviewGuideModelInheritance({ ...unset, sourceControlWriterModelSelection: selection })?.from,
    ).toBe("writing");
    expect(
      reviewGuideModelInheritance({ ...unset, reviewGuideModelSelection: selection }),
    ).toBeNull();
  });
});

function account(driver: string, id: string, enabled = true) {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(id),
    enabled,
  } as ServerProvider;
}

describe("accountGroups", () => {
  const order: ServerSettings["providerInstanceFailoverOrder"] = [
    ProviderInstanceId.make("codex-b"),
    ProviderInstanceId.make("codex-a"),
  ];

  it("groups enabled accounts of failover providers and applies the saved order", () => {
    const groups = accountGroups(order, [
      account("codex", "codex-a"),
      account("codex", "codex-b"),
      account("claudeAgent", "claude"),
    ]);
    expect(groups.map((group) => group.map((candidate) => candidate.instanceId))).toEqual([
      ["codex-b", "codex-a"],
      ["claude"],
    ]);
  });

  it("leaves out disabled accounts and providers that cannot switch accounts", () => {
    const groups = accountGroups(order, [
      account("codex", "codex-a", false),
      account("opencode", "opencode"),
    ]);
    expect(groups).toEqual([]);
  });
});
