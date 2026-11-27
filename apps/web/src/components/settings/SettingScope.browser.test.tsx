import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments })) as never,
  readEnvironment: ((id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id) ?? null) as never,
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => []) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
}));

import { SettingScope } from "./SettingScope";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const offlineId = EnvironmentId.make("offline");
const environments = [
  ...[primaryId, remoteId].map((environmentId) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" },
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      environment: {
        platform: { machine: "server" },
        capabilities: environmentId === remoteId ? { autoMode: true } : {},
      },
    },
  })),
  {
    environmentId: offlineId,
    label: offlineId,
    connection: { phase: "disconnected" },
    serverConfig: null,
  },
];

function TargetMachines({ id }: { id: string }) {
  const { targets } = useSettingsScope();
  return (
    <output aria-label={`${id} writes to`}>
      {targets.map((target) => target.environmentId).join(",")}
    </output>
  );
}

function Row({ id }: { id: SettingsSearchItemId }) {
  return (
    <SettingScope setting={id}>
      <SettingsRow {...searchableSetting(id)} control={<TargetMachines id={id} />} />
    </SettingScope>
  );
}

function Page({ viewFilter = null }: { viewFilter?: "machine" | null }) {
  return (
    <SettingsScopeProvider
      search={{ machine: primaryId }}
      onChange={() => {}}
      viewFilter={viewFilter}
    >
      <Row id="retry-threads-after-network-errors" />
      <Row id="background-activity" />
    </SettingsScopeProvider>
  );
}

const pill = (title: string) =>
  page.getByRole("button", { name: new RegExp(`^Scope of ${title}:`) });

describe("SettingScope", () => {
  it("scopes each row on its own from the pill on that row", async () => {
    await using _screen = await render(<Page />);
    const retry = searchableSetting("retry-threads-after-network-errors").title;
    const background = searchableSetting("background-activity").title;

    await userEvent.click(pill(retry));
    await userEvent.click(page.getByRole("button", { name: /^Environment scope:/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /^remote/ }));

    await expect.element(pill(retry)).toHaveAccessibleName(`Scope of ${retry}: remote`);
    await expect.element(pill(background)).toHaveAccessibleName(`Scope of ${background}: primary`);
    await expect
      .element(page.getByLabelText("retry-threads-after-network-errors writes to"))
      .toHaveTextContent("remote");
    await expect
      .element(page.getByLabelText("background-activity writes to"))
      .toHaveTextContent("primary");
  });

  // Offline, no connected machine may support it either: the pill still has to lead back.
  it.each([
    ["lacks it", primaryId, "autoMode"],
    ["is offline", offlineId, "finalReview"],
  ] as const)("keeps the pill when the scoped machine %s", async (_, machine, capability) => {
    await using _screen = await render(
      <SettingsScopeProvider search={{ machine }} onChange={() => {}}>
        <SettingScope setting="auto-mode" requires={[capability]}>
          <SettingsRow
            {...searchableSetting("auto-mode")}
            control={<TargetMachines id="auto-mode" />}
          />
        </SettingScope>
      </SettingsScopeProvider>,
    );
    const title = searchableSetting("auto-mode").title;
    await expect
      .element(page.getByText(`Not available on ${machine}.`, { exact: false }))
      .toBeVisible();

    await userEvent.click(pill(title));
    await userEvent.click(page.getByRole("button", { name: /^Environment scope:/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /^remote/ }));

    await expect.element(page.getByLabelText("auto-mode writes to")).toHaveTextContent("remote");
  });

  it("leaves a page that filters by machine on its own scope", async () => {
    await using _screen = await render(<Page viewFilter="machine" />);

    await expect
      .element(page.getByText(searchableSetting("background-activity").title))
      .toBeVisible();
    expect(page.getByRole("button", { name: /^Scope of / }).elements()).toEqual([]);
  });
});
