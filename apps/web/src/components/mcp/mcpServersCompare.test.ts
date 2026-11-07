import type { ProviderMcpServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compareMcpServers } from "./mcpServersCompare";

const server = (name: string, overrides: Partial<ProviderMcpServer> = {}): ProviderMcpServer => ({
  name,
  transport: "http",
  target: `https://${name}.example/mcp`,
  status: "connected",
  origin: "config",
  canSignIn: false,
  canSignOut: false,
  removable: true,
  ...overrides,
});

describe("compareMcpServers", () => {
  it("finds what each other machine lacks, sets up differently, or has alone", () => {
    const comparison = compareMcpServers(
      [server("docs"), server("tools", { status: "needsAuth" }), server("search")],
      [
        {
          label: "Mac",
          servers: [
            server("docs", { target: "https://docs.example/v2/mcp" }),
            // Signing in is each machine's own state, not a difference.
            server("tools"),
            server("notes"),
          ],
        },
        { label: "PC", servers: [server("docs", { status: "disabled" }), server("tools")] },
        // Still loading: neither missing nor different.
        { label: "Laptop", servers: null },
      ],
    );

    expect(Object.fromEntries(comparison.byName)).toEqual({
      docs: {
        missingOn: [],
        differentOn: [
          { label: "Mac", server: server("docs", { target: "https://docs.example/v2/mcp" }) },
          { label: "PC", server: server("docs", { status: "disabled" }) },
        ],
      },
      search: { missingOn: ["Mac", "PC"], differentOn: [] },
    });
    expect(comparison.onlyElsewhere).toEqual([{ name: "notes", labels: ["Mac"] }]);
  });
});
