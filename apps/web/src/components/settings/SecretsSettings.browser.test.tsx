import {
  AuthProvidersManageScope,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  SecretProviderKind,
  type SecretProviderConfig,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  serviceAccountSupported: undefined as boolean | undefined,
  secretProviders: {} as Record<string, SecretProviderConfig>,
  updateSettings: vi.fn(),
}));

vi.mock(import("./SettingsScopeContext"), () => ({
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentId: EnvironmentId.make("remote") },
    environment: {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote host",
      connection: { phase: "connected" },
      serverConfig: {
        secretProviderSettings: true,
        ...(state.serviceAccountSupported === undefined
          ? {}
          : { onePasswordServiceAccount: state.serviceAccountSupported }),
      },
    },
  })) as never,
}));

vi.mock(import("../../state/session"), () => ({
  useEnvironmentSessionState: () => ({
    data: {
      authenticated: true,
      scopes: [AuthProvidersManageScope],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "t3_session",
      },
    },
    hasError: false,
    isPending: false,
  }),
}));

vi.mock(import("../../hooks/useSettings"), () => ({
  useEnvironmentSettings: ((_: EnvironmentId, select?: (settings: UnifiedSettings) => unknown) => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, secretProviders: state.secretProviders };
    return select === undefined ? settings : select(settings);
  }) as never,
  useUpdateEnvironmentSettings: () => state.updateSettings,
}));

vi.mock(import("./settingsLayout"), () => ({
  SettingsPageContainer: ({ children }) => <div>{children}</div>,
  SettingsSection: ({ children, headerAction }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ title, description, control }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

import { SecretsSettingsPanel } from "./SecretsSettings";

const dialog = () => page.getByRole("dialog");
const authMethod = () => dialog().getByRole("combobox", { name: /Authentication method/ });
const linuxOption = () => page.getByRole("option", { name: "Linux service account" });

function setup({
  serviceAccountSupported,
  secretProviders = {},
}: {
  serviceAccountSupported?: boolean;
  secretProviders?: Record<string, SecretProviderConfig>;
} = {}) {
  state.serviceAccountSupported = serviceAccountSupported;
  state.secretProviders = secretProviders;
  state.updateSettings.mockReset();
}

describe("Linux service account settings", () => {
  it("adds a service account on a supporting host using the name alone", async () => {
    setup({ serviceAccountSupported: true });
    await using screen = await render(<SecretsSettingsPanel />);

    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await expect.element(authMethod()).toHaveTextContent("Desktop integration");
    await userEvent.click(authMethod());
    await userEvent.click(linuxOption());
    await expect.element(authMethod()).toHaveTextContent("Linux service account");
    await expect.element(dialog().getByLabelText("Account")).not.toBeInTheDocument();
    await expect.element(dialog().getByLabelText(/token/i)).not.toBeInTheDocument();
    await userEvent.fill(dialog().getByRole("textbox", { name: "Name" }), "Build vault");
    await userEvent.click(dialog().getByRole("button", { name: "Add provider" }));

    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      secretProviders: {
        "build-vault": {
          kind: "one_password",
          label: "Build vault",
          config: { auth: "linux-service-account" },
        },
      },
    });
  });

  it("disables adding a service account when the host omits the capability", async () => {
    setup();
    await using screen = await render(<SecretsSettingsPanel />);

    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await userEvent.click(authMethod());

    await expect.element(linuxOption()).toBeDisabled();
  });

  it("preserves existing service account authentication when editing on a host without the capability", async () => {
    setup({
      secretProviders: {
        "build-vault": {
          kind: SecretProviderKind.make("one_password"),
          label: "Build vault",
          config: { auth: "linux-service-account" },
        },
      },
    });
    await using screen = await render(<SecretsSettingsPanel />);

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await expect.element(authMethod()).toHaveTextContent("Linux service account");
    await userEvent.fill(dialog().getByRole("textbox", { name: "Name" }), "Build tools");
    await userEvent.click(dialog().getByRole("button", { name: "Save changes" }));

    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
      secretProviders: {
        "build-vault": {
          kind: "one_password",
          label: "Build tools",
          config: { auth: "linux-service-account" },
        },
      },
    });
  });
});
