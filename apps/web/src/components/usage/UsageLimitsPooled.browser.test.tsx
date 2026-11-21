import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";
import { AccountFailoverNotice } from "./UsageLimitsStatus";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it.each(["off", "ready", "switched", "exhausted"] as const)(
    "links the %s failover state to its owning settings",
    async (kind) => {
      const active = managedChatGpt("chatgpt_work", "ChatGPT Work");
      await using screen = await render(
        <AccountFailoverNotice
          entries={[
            {
              environmentId: EnvironmentId.make("desk"),
              environmentLabel: "Desk",
              driver: ProviderDriverKind.make("codex"),
              status: { kind, active, limited: [active], until: null },
            },
          ]}
          now={Date.parse(checkedAt)}
          showEnvironment={false}
        />,
      );
      await expect
        .element(
          screen.getByRole("link", {
            name: kind === "off" ? "Turn on in Settings" : "Account order",
          }),
        )
        .toHaveAttribute(
          "href",
          kind === "off"
            ? "/settings/threads?machine=desk#usage-limit-recovery"
            : "/settings/providers?machine=desk#account-failover",
        );
    },
  );
  it("lists managed connections under Codex even when no account reports a bar", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(<UsageLimitsPooled presentations={presentations} />);

    await expect.element(screen.getByRole("heading", { name: "Codex" })).toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Limits kept by ChatGPT" }))
      .toBeVisible();
    await expect.element(screen.getByText("ChatGPT Work")).toBeVisible();
    await expect.element(screen.getByText("ChatGPT Personal")).toBeVisible();
  });
});

function accountReadings(...accounts: readonly (readonly [string, string])[]) {
  return new Map([
    [
      EnvironmentId.make("desk"),
      {
        entry: { target: { label: "Desk" } },
        serverConfig: {
          providers: accounts.map(([name, resetsAt]) => ({
            ...managedChatGpt(name.toLowerCase(), name),
            usageLimits: {
              checkedAt,
              windows: [
                {
                  id: "primary",
                  kind: "session" as const,
                  label: "5-hour",
                  usedPercent: 20,
                  windowDurationMins: 300,
                  resetsAt,
                },
              ],
            },
          })),
        },
      },
    ],
  ]);
}

it("updates the limit countdown at the minute and reset boundaries", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date(checkedAt));
  const presentations = accountReadings(["Alpha", "2026-10-25T16:01:30.000Z"]);
  await using screen = await render(<UsageLimitsPooled presentations={presentations} />);
  const segment = screen.getByRole("button", { name: /Alpha: 80% left/ });
  await expect.element(segment).toHaveAccessibleName(/1m/);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  await expect.element(segment).toHaveAccessibleName(/Resets momentarily/);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  await expect.element(segment).toHaveAccessibleName(/resets now/);
});

it("keeps pooled account columns stable when the reset order changes", async () => {
  const early = "2026-10-25T17:00:00.000Z";
  const late = "2026-10-25T18:00:00.000Z";
  await using screen = await render(
    <UsageLimitsPooled presentations={accountReadings(["Alpha", early], ["Beta", late])} />,
  );
  const alpha = screen.getByRole("button", { name: /Alpha: 80% left/ });
  await expect.element(alpha).toHaveStyle("grid-column: 1");
  await screen.rerender(
    <UsageLimitsPooled presentations={accountReadings(["Alpha", late], ["Beta", early])} />,
  );
  await expect.element(alpha).toHaveStyle("grid-column: 1");
});
