import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { keepsLastPickedModel, resolveNewThreadModelSelectionOverride } from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        keepLastPicked: false,
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        keepLastPicked: false,
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("leaves the last pick above the project default and the carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        keepLastPicked: true,
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toBeNull();
  });

  it("keeps the last pick only when the setting is on and this device has picked a model", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const picked = {
      stickyActiveProvider: instanceId,
      stickyModelSelectionByProvider: { [instanceId]: CARRIED_SELECTION },
    };
    const unpicked = { stickyActiveProvider: null, stickyModelSelectionByProvider: {} };
    expect([
      keepsLastPickedModel({ newThreadsUseLastModel: true }, picked),
      keepsLastPickedModel({ newThreadsUseLastModel: true }, unpicked),
      keepsLastPickedModel({ newThreadsUseLastModel: false }, picked),
    ]).toEqual([true, false, false]);
  });
});
