import {
  EnvironmentId,
  UsageLimitSourceId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useUsageLimitNow } from "../../hooks/useUsageNow";
import { CHATGPT_USAGE_URL, limitAccountWorkspaces } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

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
  const all = Atom.make(presentations);
  function Limits() {
    return <UsageLimitsPooled presentations={presentations} now={useUsageLimitNow(all)} />;
  }
  await using screen = await render(<Limits />);
  const segment = screen.getByRole("button", { name: /Alpha: 80% left/ });
  await expect.element(segment).toHaveAccessibleName(/1m/);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  await expect.element(segment).toHaveAccessibleName(/↻ <1m/);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  await expect.element(segment).toHaveAccessibleName(/resets now/);
});

it("keeps pooled account columns stable when the reset order changes", async () => {
  const early = "2026-10-25T17:00:00.000Z";
  const late = "2026-10-25T18:00:00.000Z";
  await using screen = await render(
    <UsageLimitsPooled
      presentations={accountReadings(["Alpha", early], ["Beta", late])}
      now={Date.parse(checkedAt)}
    />,
  );
  const alpha = screen.getByRole("button", { name: /Alpha: 80% left/ });
  await expect.element(alpha).toHaveStyle("grid-column: 1");
  await screen.rerender(
    <UsageLimitsPooled
      presentations={accountReadings(["Alpha", late], ["Beta", early])}
      now={Date.parse(checkedAt)}
    />,
  );
  await expect.element(alpha).toHaveStyle("grid-column: 1");
});

it("uses hidden accounts' deadlines for the filtered Limits countdown", async () => {
  using _timers = fakeTimers();
  vi.setSystemTime(new Date(checkedAt));
  const beta = ["Beta", "2026-10-25T16:02:10.000Z"] as const;
  const full = accountReadings(["Alpha", "2026-10-25T16:00:30.000Z"], beta);
  const filtered = accountReadings(beta);
  const all = Atom.make(full);

  function Limits() {
    const now = useUsageLimitNow(all);
    return (
      <>
        <UsageLimitsPooled presentations={full} now={now} />
        <UsageLimitsPooled presentations={filtered} now={now} />
      </>
    );
  }

  await using screen = await render(<Limits />);
  const rows = screen.getByRole("button", { name: /Beta: 80% left/ });
  await expect.element(rows.nth(0)).toHaveAccessibleName(/2m/);
  await expect.element(rows.nth(1)).toHaveAccessibleName(/2m/);
  await act(() => vi.advanceTimersByTimeAsync(40_000));
  await expect.element(rows.nth(0)).toHaveAccessibleName(/1m/);
  await expect.element(rows.nth(1)).toHaveAccessibleName(/1m/);
});

it("closes a work workspace detail when only the personal workspace starts reporting", async () => {
  const now = Date.parse(checkedAt);
  const reading = (workspaceId: string, usedPercent: number) => {
    const input = accountReadings([workspaceId, "2026-10-25T17:00:00.000Z"]);
    const desk = input.get(EnvironmentId.make("desk"))!;
    const provider = desk.serverConfig.providers[0]!;
    return new Map([
      [
        EnvironmentId.make("desk"),
        {
          ...desk,
          serverConfig: {
            providers: [
              {
                ...provider,
                auth: { ...provider.auth, email: "a@example.com", workspaceId },
                usageLimits: {
                  ...provider.usageLimits,
                  windows: [{ ...provider.usageLimits.windows[0]!, usedPercent }],
                },
              },
            ],
          },
        },
      ],
    ]);
  };
  await using screen = await render(
    <UsageLimitsPooled presentations={reading("work", 20)} now={now} />,
  );
  await screen.getByRole("button", { name: /work: 80% left/ }).click();
  const detail = page.getByRole("dialog");
  await expect.element(detail.getByText("work", { exact: true })).toBeVisible();
  await screen.rerender(<UsageLimitsPooled presentations={reading("personal", 25)} now={now} />);
  await expect.element(detail).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /personal: 75% left/ })).toBeVisible();
});

it("keeps the web workspace detail open on the hub reading after a native timeout", async () => {
  const now = Date.parse(checkedAt);
  const base = accountReadings(["NativeWork", "2026-10-25T17:00:00.000Z"]);
  const desk = base.get(EnvironmentId.make("desk"))!;
  const native: ServerProvider = {
    ...desk.serverConfig.providers[0]!,
    auth: { status: "authenticated", email: "a@example.com", workspaceId: "work" },
  };
  const make = (provider: ServerProvider, usedPercent: number) =>
    new Map([
      [
        EnvironmentId.make("desk"),
        {
          ...desk,
          serverConfig: {
            providers: [provider],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                checkedAt,
                kind: "cliproxy" as const,
                label: "Hub",
                accounts: [
                  {
                    id: "a.json",
                    driver: native.driver,
                    email: "a@example.com",
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...native.usageLimits!.windows[0]!, usedPercent }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
  const ready = make(native, 20);
  const workspaces = limitAccountWorkspaces(ready);
  await using screen = await render(
    <UsageLimitsPooled presentations={ready} now={now} workspaces={workspaces} />,
  );
  await screen.getByRole("button", { name: /NativeWork: 80% left/ }).click();
  const detail = page.getByRole("dialog");
  await expect.element(detail.getByText("80%", { exact: true })).toBeVisible();
  const timeout = make(
    {
      ...native,
      auth: { status: "unknown" },
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    },
    25,
  );
  await screen.rerender(
    <UsageLimitsPooled
      presentations={timeout}
      now={now}
      workspaces={limitAccountWorkspaces(timeout, workspaces)}
    />,
  );
  await expect.element(detail.getByText("75%", { exact: true })).toBeVisible();
});

it("labels freshness from the same observation time as the pool countdown", async () => {
  using _timers = fakeTimers();
  const now = Date.parse(checkedAt);
  vi.setSystemTime(now);
  const presentations = accountReadings(["Desk", "2026-10-25T16:10:00.000Z"]);
  await using screen = await render(<UsageLimitsPooled presentations={presentations} now={now} />);
  await expect.element(screen.getByText("Checked just now")).toBeVisible();
  await screen.rerender(<UsageLimitsPooled presentations={presentations} now={now + 120_000} />);
  expect(screen.container.textContent).toContain("Checked 2m ago");
});
