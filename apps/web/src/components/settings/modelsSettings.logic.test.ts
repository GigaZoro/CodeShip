import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { isProviderInstancePickerReady } from "~/providerInstances";
import {
  accountGroups,
  autoModeModelChoices,
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

describe("autoModeModelChoices", () => {
  it("offers what each account Auto can run on this machine offers under its own settings", () => {
    const instance = (customModels: ReadonlyArray<string> = [], enabled = true) => ({
      driver: ProviderDriverKind.make("codex"),
      enabled,
      config: { customModels },
    });
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex-a")]: instance(),
        [ProviderInstanceId.make("codex-b")]: instance(["b-custom"]),
        [ProviderInstanceId.make("codex-warning")]: instance(),
        [ProviderInstanceId.make("codex-off")]: instance([], false),
        [ProviderInstanceId.make("codex-out")]: instance(),
      },
      providerModelPreferences: {
        [ProviderInstanceId.make("codex-b")]: { hiddenModels: ["gpt-5"], modelOrder: [] },
      },
    };
    const choices = autoModeModelChoices(
      [
        account("codex", "codex-warning", true, { models: ["gpt-6.1-sol"], status: "warning" }),
        account("codex", "codex-a", true, { models: ["gpt-6-astra"] }),
        account("codex", "codex-b", true, { models: ["gpt-6.2-astra", "gpt-6-astra", "gpt-5"] }),
        // Enabled in some project, but not on this machine.
        account("codex", "codex-off", true, { models: ["gpt-7-off"] }),
        account("codex", "codex-out", true, { models: ["gpt-7-out"], signedOut: true }),
      ],
      settings,
    );
    expect({
      instanceId: choices.entry.instanceId,
      models: choices.entry.models.map((model) => model.slug),
      options: choices.options.map((option) => option.slug),
    }).toEqual({
      instanceId: "codex-a",
      models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.2-astra", "gpt-5"],
      options: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.2-astra", "b-custom"],
    });
  });

  it("lets the picker list the models of a provider whose every account only warned", () => {
    const choices = autoModeModelChoices(
      [account("codex", "codex", true, { models: ["gpt-6-astra"], status: "warning" })],
      DEFAULT_UNIFIED_SETTINGS,
    );
    expect(isProviderInstancePickerReady(choices.entry)).toBe(true);
  });
});

function account(
  driver: string,
  id: string,
  enabled = true,
  {
    models = [],
    signedOut = false,
    status = "ready",
  }: {
    models?: ReadonlyArray<string>;
    signedOut?: boolean;
    status?: ServerProvider["status"];
  } = {},
): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(id),
    enabled,
    installed: true,
    version: null,
    status,
    auth: { status: signedOut ? "unauthenticated" : "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
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
