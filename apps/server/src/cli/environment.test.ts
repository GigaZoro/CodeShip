import { EnvironmentId } from "@t3tools/contracts/baseSchemas";
import { PEER_LINK_AGENTS_ONLY_NOTE } from "@t3tools/contracts/peerLink";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { formatLinked, formatLinks } from "./environment.ts";

const expiresAt = DateTime.makeUnsafe("2027-01-01T00:00:00.000Z");

describe("environment link output", () => {
  it("says a new link is for agents only and not in the app's machine list", () => {
    const out = formatLinked({
      environmentId: EnvironmentId.make("env-box"),
      label: "Box",
      urls: ["https://box.example.ts.net"],
      access: "auto",
      linkedAt: expiresAt,
      expiresAt,
      lastReachedAt: null,
      lastError: null,
    });
    expect(out).toContain("Linked Box");
    expect(out).toContain(PEER_LINK_AGENTS_ONLY_NOTE);
  });

  it("says the same under a list of links, and not under an empty one", () => {
    const listed = formatLinks([
      {
        environmentId: EnvironmentId.make("env-box"),
        label: "Box",
        urls: ["https://box.example.ts.net"],
        access: "auto",
        linkedAt: expiresAt,
        expiresAt,
        lastReachedAt: null,
        lastError: null,
        status: "reachable",
      },
    ]);
    expect(listed).toContain(PEER_LINK_AGENTS_ONLY_NOTE);
    expect(formatLinks([])).toBe("No linked environments.\n");
  });

  it.each([null, "warning"] as const)(
    "names a version this one cannot read once, with the last error %s",
    (lastError) => {
      const warning =
        "Box runs T3.CodeShip 0.0.1, older than 0.0.2 here. Update T3.CodeShip on Box.";
      const listed = formatLinks([
        {
          environmentId: EnvironmentId.make("env-box"),
          label: "Box",
          urls: ["https://box.example.ts.net"],
          access: "auto",
          linkedAt: expiresAt,
          expiresAt,
          lastReachedAt: null,
          lastError: lastError === null ? null : warning,
          status: "reachable",
          versionWarning: warning,
        },
      ]);
      expect(listed.split(warning)).toHaveLength(2);
    },
  );
});
