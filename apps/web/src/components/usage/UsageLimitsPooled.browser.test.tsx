import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
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
