import { RegistryProvider } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { useState, type ComponentProps } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { ComposerControlsBar } from "./ComposerControlsBar";
import { markOpenToPermissions } from "./composerEventScope";
import { resolveRuntimeModeOption, runtimeModeOptions } from "./runtimeModeConfig";

const environmentId = EnvironmentId.make("auto-composer");
const instanceId = ProviderInstanceId.make("claude");
const codexInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("claudeAgent");
const models = ["sonnet", "opus"].map((model) => ({
  slug: model,
  name: `Claude ${model}`,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
    ],
  },
}));
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  },
  {
    instanceId: codexInstanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-test",
        name: "GPT Test",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "ultra", label: "Ultra" },
              ],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  },
]);
const saved: ModelSelection = {
  instanceId,
  model: "sonnet",
  options: [{ id: "effort", value: "medium" }],
  autoAccount: true,
};
const autoPick: ModelSelection = {
  instanceId,
  model: "opus",
  options: [{ id: "effort", value: "xhigh" }],
  autoAccount: true,
};
const config = {
  environment: { capabilities: { autoMode: true } },
  settings: { ...DEFAULT_SERVER_SETTINGS, autoModeProvider: driver },
};
function Controls(overrides: Partial<ComponentProps<typeof ComposerControlsBar>>) {
  const [open, setOpen] = useState(false);
  return (
    <RegistryProvider initialValues={[[serverEnvironment.configValueAtom(environmentId), config]]}>
      <ComposerControlsBar
        environmentId={environmentId}
        workspaceCwd={null}
        routeKind="server"
        routeThreadRef={{ environmentId, threadId: ThreadId.make("auto-thread") }}
        draftId={null}
        selectedProvider={driver}
        selectedInstanceId={instanceId}
        selectedModel={saved.model}
        selectedProviderModels={models}
        composerModelOptions={{ [instanceId]: saved.options }}
        reportedModelSelection={saved}
        promptUltrathink="none"
        onPromptEdit={() => {}}
        effortDisplay="label"
        compatibleRuntimeMode="auto"
        defaultRuntimeMode="auto"
        compatibleRuntimeModeOptions={[]}
        handleRuntimeModeChange={() => {}}
        composerControlsCollapsed={false}
        showProviderUnavailable={false}
        providerSetupInstanceId={undefined}
        providerUnavailableLabel=""
        onOpenProviderSetup={() => {}}
        providerCatalogPending={false}
        isSendBusy={false}
        multipleModelsEnabled={false}
        multipleModelSelections={null}
        onMultipleModelSelectionsChange={() => {}}
        selectedModelSelection={saved}
        autoPick={autoPick}
        onProviderModelSelect={() => {}}
        activeThreadModelSelection={saved}
        selectedModelForPickerWithCustomFallback={saved.model}
        lockedProvider={driver}
        lockedContinuationGroupKey={null}
        providerInstanceEntries={entries}
        keybindings={compileResolvedKeybindingsConfig([])}
        modelOptionsByInstance={
          new Map(
            entries.map((entry) => [
              entry.instanceId,
              entry.models.map(({ slug, name, isCustom }) => ({ slug, name, isCustom })),
            ]),
          )
        }
        terminalOpen={false}
        modelPickerOpen={open}
        onModelPickerOpenChange={setOpen}
        modelPickerIconClassName={undefined}
        getModelDisabledReason={() => null}
        {...overrides}
      />
    </RegistryProvider>
  );
}

it("keeps Auto's displayed model and effort in sync with its settings instead of the chat", async () => {
  await using screen = await render(<Controls />);
  const trigger = screen.getByRole("button", { name: /Claude .*Auto/ });
  await expect.element(trigger).toHaveTextContent("AutoExtra High");
  await expect
    .element(trigger)
    .toHaveAccessibleName("Claude opus, Auto, Extra High, Permissions: Auto");
  await trigger.click();
  await expect
    .element(page.getByRole("option", { name: /Auto Claude opus · Extra High/ }))
    .toBeVisible();

  await screen.rerender(
    <Controls
      autoPick={{ ...autoPick, options: [] }}
      selectedModel="opus"
      composerModelOptions={null}
      reportedModelSelection={{ ...saved, model: "opus" }}
    />,
  );
  await expect.element(trigger).toHaveTextContent("AutoHigh");
  await expect.element(trigger).toHaveAccessibleName("Claude opus, Auto, High, Permissions: Auto");
  await expect.element(page.getByRole("option", { name: /Auto Claude opus · High/ })).toBeVisible();

  await screen.rerender(
    <Controls
      autoPick={{
        instanceId: codexInstanceId,
        model: "gpt-test",
        options: [{ id: "reasoningEffort", value: "ultra" }],
        autoAccount: true,
      }}
      lockedProvider={null}
    />,
  );
  await expect
    .element(
      screen.getByRole("button", { name: "GPT Test, Auto, Ultra, Permissions: Auto", exact: true }),
    )
    .toHaveTextContent("AutoUltra");
  await expect.element(page.getByRole("option", { name: /Auto GPT Test · Ultra/ })).toBeVisible();

  await screen.rerender(<Controls selectedModelSelection={{ ...saved, autoAccount: false }} />);
  await expect
    .element(
      screen.getByRole("button", { name: "Claude sonnet, Medium, Permissions: Auto", exact: true }),
    )
    .toHaveTextContent("sonnetMedium");
  await expect
    .element(page.getByRole("radio", { name: "Medium" }))
    .toHaveAttribute("aria-checked", "true");
});

const permissionOptions = runtimeModeOptions.map((mode) => resolveRuntimeModeOption(mode));

function RunChip(props: {
  initialMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode;
  options?: typeof permissionOptions;
}) {
  const [mode, setMode] = useState<RuntimeMode>(props.initialMode);
  return (
    <div data-slot="composer-shell">
      <Controls
        selectedModelSelection={{ ...saved, autoAccount: false }}
        compatibleRuntimeMode={mode}
        defaultRuntimeMode={props.defaultRuntimeMode}
        compatibleRuntimeModeOptions={props.options ?? permissionOptions}
        handleRuntimeModeChange={setMode}
      />
      <p role="status" aria-label="Current mode">
        {mode}
      </p>
    </div>
  );
}

it("names only a non-default mode in the run chip and changes it from the same popover", async () => {
  await using screen = await render(
    <RunChip initialMode="approval-required" defaultRuntimeMode="approval-required" />,
  );
  const chip = screen.getByRole("button", { name: /Claude sonnet/ });
  await expect.element(chip).toHaveAccessibleName(/Permissions: Supervised$/);
  await expect.element(chip.getByText("Supervised")).not.toBeInTheDocument();

  await chip.click();
  await page.getByRole("radio", { name: "Auto-accept edits" }).click();
  await expect
    .element(screen.getByRole("status", { name: "Current mode" }))
    .toHaveTextContent("auto-accept-edits");
  await expect.element(chip.getByText("Auto-accept edits")).toBeVisible();
});

it("always shows full access in the run chip, even when it is the default", async () => {
  await using screen = await render(
    <RunChip initialMode="full-access" defaultRuntimeMode="full-access" />,
  );
  const chip = screen.getByRole("button", { name: /Claude sonnet/ });
  await expect.element(chip.getByText("Full access")).toBeVisible();
});

it("opens on the checked permission when composer.mode marked the run chip", async () => {
  await using screen = await render(
    <RunChip initialMode="auto-accept-edits" defaultRuntimeMode="approval-required" />,
  );
  const chip = screen.getByRole("button", { name: /Claude sonnet/ });
  markOpenToPermissions(chip.element() as HTMLElement);
  await chip.click();
  await expect.element(page.getByRole("radio", { name: "Auto-accept edits" })).toHaveFocus();

  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(screen.getByRole("status", { name: "Current mode" }))
    .toHaveTextContent("auto");
  await expect.element(page.getByRole("radio", { name: "Auto", exact: true })).toHaveFocus();
});

it("keeps a mode blocked by policy reachable to read why, and arrows past it", async () => {
  const blockedReason = "Your organization manages this";
  const options = permissionOptions.map((option) =>
    option.mode === "full-access" ? { ...option, disabledReason: blockedReason } : option,
  );
  await using screen = await render(
    <RunChip initialMode="full-access" defaultRuntimeMode="auto" options={options} />,
  );
  const chip = screen.getByRole("button", { name: /Claude sonnet/ });
  markOpenToPermissions(chip.element() as HTMLElement);
  await chip.click();
  const fullAccess = page.getByRole("radio", { name: "Full access" });
  await expect.element(fullAccess).toHaveFocus();
  await expect.element(fullAccess).toHaveAccessibleDescription(blockedReason);

  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(screen.getByRole("status", { name: "Current mode" }))
    .toHaveTextContent("approval-required");
  await userEvent.keyboard("{ArrowLeft}");
  await expect
    .element(screen.getByRole("status", { name: "Current mode" }))
    .toHaveTextContent("auto");
});
