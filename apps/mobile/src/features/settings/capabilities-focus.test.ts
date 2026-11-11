import { describe, expect, it } from "vite-plus/test";

import {
  focusedServerFirst,
  isCapabilitiesFocused,
  matchesCapabilitiesFocus,
} from "./capabilities-focus";

const account = { environmentId: "mac", instanceId: "claudeAgent_work" };

describe("capabilities focus", () => {
  it("is off without params, and on when any of them is present", () => {
    expect(isCapabilitiesFocused(undefined)).toBe(false);
    expect(isCapabilitiesFocused({})).toBe(false);
    expect(isCapabilitiesFocused({ server: "threadpage" })).toBe(true);
  });

  it("keeps only the named environment and account, and everything without a focus", () => {
    expect(matchesCapabilitiesFocus(undefined, account)).toBe(true);
    expect(matchesCapabilitiesFocus({ environmentId: "mac" }, account)).toBe(true);
    // An environment alone is checked against the environment only.
    expect(
      matchesCapabilitiesFocus(
        { environmentId: "mac", instanceId: "claudeAgent" },
        { environmentId: "mac" },
      ),
    ).toBe(true);
    expect(matchesCapabilitiesFocus({ environmentId: "vps" }, account)).toBe(false);
    expect(
      matchesCapabilitiesFocus({ environmentId: "mac", instanceId: "claudeAgent" }, account),
    ).toBe(false);
    expect(
      matchesCapabilitiesFocus({ environmentId: "mac", instanceId: "claudeAgent_work" }, account),
    ).toBe(true);
  });

  it("moves the named server to the top and leaves the order alone when it is absent", () => {
    const servers = [{ name: "alpha" }, { name: "threadpage" }, { name: "minions" }];
    expect(focusedServerFirst(servers, { server: "threadpage" }).map((s) => s.name)).toEqual([
      "threadpage",
      "alpha",
      "minions",
    ]);
    expect(focusedServerFirst(servers, { server: "gone" })).toBe(servers);
    expect(focusedServerFirst(servers, undefined)).toBe(servers);
  });
});
