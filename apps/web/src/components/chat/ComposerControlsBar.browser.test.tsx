import { RegistryProvider } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { useState, type ComponentProps } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { ComposerControlsBar } from "./ComposerControlsBar";

it("keeps Auto's displayed model and effort in sync with its settings instead of the chat", async () => {
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
      <RegistryProvider
        initialValues={[[serverEnvironment.configValueAtom(environmentId), config]]}
      >
        <ComposerControlsBar
          environmentId={environmentId}
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
          composerControlsHidden={false}
          restingHiddenBlockCount={0}
          iconOnlyBlockCount={0}
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

  await using screen = await render(<Controls />);
  const trigger = screen.getByRole("button", { name: /Claude .*Auto/ });
  await expect.element(trigger).toHaveTextContent("AutoExtra High");
  await expect.element(trigger).toHaveAccessibleName("Claude opus, Auto, Extra High");
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
  await expect.element(trigger).toHaveAccessibleName("Claude opus, Auto, High");
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
    .element(screen.getByRole("button", { name: "GPT Test, Auto, Ultra", exact: true }))
    .toHaveTextContent("AutoUltra");
  await expect.element(page.getByRole("option", { name: /Auto GPT Test · Ultra/ })).toBeVisible();

  await screen.rerender(<Controls selectedModelSelection={{ ...saved, autoAccount: false }} />);
  await expect
    .element(screen.getByRole("button", { name: "Claude sonnet, Medium", exact: true }))
    .toHaveTextContent("sonnetMedium");
  await expect
    .element(page.getByRole("radio", { name: "Medium" }))
    .toHaveAttribute("aria-checked", "true");
});
