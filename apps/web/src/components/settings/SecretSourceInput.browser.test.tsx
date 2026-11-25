import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  SecretProviderId,
  SecretProviderKind,
  type UnifiedSettings,
} from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { SecretSourceInput, type SecretSource, useSecretSources } from "./SecretSourceInput";

const personal = SecretProviderId.make("personal");
const work = SecretProviderId.make("work");
const sources = [
  {
    id: personal,
    kind: SecretProviderKind.make("one_password"),
    label: "Personal",
    auth: "desktop",
  },
  { id: work, kind: SecretProviderKind.make("one_password"), label: "Work", auth: "desktop" },
] as const satisfies ReadonlyArray<SecretSource>;

vi.mock(import("../../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const older = Atom.make({ secretReferences: true });
  const unsupported = Atom.make({ secretReferences: true, onePasswordServiceAccount: false });
  const supported = Atom.make({ secretReferences: true, onePasswordServiceAccount: true });
  return {
    serverEnvironment: {
      configValueAtom: (environmentId: EnvironmentId) =>
        environmentId === "remote-supported"
          ? supported
          : environmentId === "remote-unsupported"
            ? unsupported
            : older,
    } as never,
  };
});

vi.mock(import("../../hooks/useSettings"), () => ({
  useEnvironmentSettings: ((_: EnvironmentId, select: (settings: UnifiedSettings) => unknown) =>
    select({
      ...DEFAULT_UNIFIED_SETTINGS,
      secretProviders: {
        [personal]: { kind: sources[0].kind, label: "Personal", config: { account: "personal" } },
        [work]: {
          kind: sources[1].kind,
          label: "Work",
          config: { auth: "linux-service-account" },
        },
      },
    })) as never,
}));

function ConfiguredSecretSourceInput({
  environmentId,
  ...props
}: Pick<ComponentProps<typeof SecretSourceInput>, "value" | "onSecretChange"> & {
  environmentId: EnvironmentId;
}) {
  const sources = useSecretSources(environmentId);
  return (
    <SecretSourceInput aria-label="API key" sources={sources} onCommit={() => {}} {...props} />
  );
}

const reference = (screen: Screen) => screen.getByRole("textbox", { name: "API key reference" });

async function commitReference(screen: Screen, value: string) {
  await userEvent.clear(reference(screen));
  await userEvent.type(reference(screen), value);
  await userEvent.keyboard("{Enter}");
}

describe("SecretSourceInput", () => {
  it("moves a reference to another provider only once one is committed for it", async () => {
    const onSecretChange = vi.fn();
    const onValidityChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API key"
        value={{ provider: personal, reference: "op://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
        onValidityChange={onValidityChange}
      />,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "API key source" }));
    await userEvent.click(screen.getByRole("option", { name: "Work" }));
    expect(onSecretChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    await expect.element(reference(screen)).toHaveValue("");

    await commitReference(screen, "op://Shared/OpenAI test/credential");
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith({
      provider: work,
      reference: "op://Shared/OpenAI test/credential",
    });
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("removes an existing service account reference on an unsupported host", async () => {
    const onSecretChange = vi.fn();
    await using screen = await render(
      <ConfiguredSecretSourceInput
        environmentId={EnvironmentId.make("remote-unsupported")}
        value={{ provider: work, reference: "op://Private/OpenAI/credential" }}
        onSecretChange={onSecretChange}
      />,
    );

    await expect.element(reference(screen)).toHaveValue("op://Private/OpenAI/credential");
    await userEvent.clear(reference(screen));
    await userEvent.keyboard("{Enter}");
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each([
    ["remote-older", false],
    ["remote-unsupported", false],
    ["remote-supported", true],
  ] as const)(
    "sets service account availability for new mappings on %s to %s",
    async (host, serviceAccountSupported) => {
      await using screen = await render(
        <ConfiguredSecretSourceInput
          environmentId={EnvironmentId.make(host)}
          value=""
          onSecretChange={vi.fn()}
        />,
      );

      await userEvent.click(screen.getByRole("combobox", { name: "API key source" }));

      await expect.element(page.getByRole("option", { name: "Personal" })).toBeVisible();
      const option = expect.element(page.getByRole("option", { name: "Work" }));
      if (serviceAccountSupported === true) await option.toBeVisible();
      else await option.not.toBeInTheDocument();
    },
  );

  it("rejects a reference 1Password cannot read", async () => {
    const onSecretChange = vi.fn();
    const onValidityChange = vi.fn();
    await using screen = await render(
      <SecretSourceInput
        aria-label="API key"
        value={{ provider: personal, reference: "op://Private/OpenAI/credential" }}
        sources={sources}
        onCommit={() => {}}
        onSecretChange={onSecretChange}
        onValidityChange={onValidityChange}
      />,
    );

    await commitReference(screen, "Private/OpenAI/credential");
    expect(onSecretChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    await expect.element(reference(screen)).toHaveAttribute("aria-invalid", "true");
    await expect.element(reference(screen)).toHaveValue("Private/OpenAI/credential");
    await commitReference(screen, "op://Private/OpenAI/replacement");
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(onSecretChange).toHaveBeenCalledExactlyOnceWith({
      provider: personal,
      reference: "op://Private/OpenAI/replacement",
    });
  });

  it.each(["op://Private/OpenAI/API key", "op://Private/OpenAI/credential?attribute=otp"])(
    "requires a CLI-safe reference for a Linux service account when given %s",
    async (unsupportedReference) => {
      const onSecretChange = vi.fn();
      await using screen = await render(
        <SecretSourceInput
          aria-label="API key"
          value={{ provider: personal, reference: "op://Private/OpenAI/credential" }}
          sources={[{ ...sources[0], auth: "linux-service-account" }]}
          onCommit={() => {}}
          onSecretChange={onSecretChange}
        />,
      );

      await commitReference(screen, unsupportedReference);

      expect(onSecretChange).not.toHaveBeenCalled();
      await expect.element(reference(screen)).toHaveAccessibleDescription(/Use IDs/);
    },
  );
});
