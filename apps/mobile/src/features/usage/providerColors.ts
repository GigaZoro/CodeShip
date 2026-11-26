import type { UsageProviderKind } from "@t3tools/contracts";

export function providerColors(scheme: "light" | "dark"): Record<UsageProviderKind, string> {
  return {
    claude: scheme === "dark" ? "#d97757" : "#cc6d4f",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
    cursor: "#8b8b8b",
    opencode: scheme === "dark" ? "#5b9bbd" : "#518ba9",
    antigravity: "#8c7bd1",
    pi: scheme === "dark" ? "#4d9f8a" : "#438f7c",
    muse: "#0866ff",
  };
}
