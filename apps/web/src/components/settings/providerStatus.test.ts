// @effect-diagnostics nodeBuiltinImport:off - scans the web sources for provider status renderers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderStatus, getProviderVersionAdvisoryPresentation } from "./providerStatus";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", label: "ChatGPT" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("deriveProviderStatus", () => {
  it("does not hide a provider error behind a previous authenticated state", () => {
    expect(
      deriveProviderStatus({
        ...provider,
        status: "error",
        message: "The provider process failed to start.",
      }),
    ).toEqual({
      key: "error",
      headline: "Unavailable",
      detail: "The provider process failed to start.",
    });
  });

  it("keeps authentication failures actionable when their provider status is error", () => {
    expect(
      deriveProviderStatus({
        ...provider,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Run codex login.",
      }),
    ).toEqual({
      key: "error",
      headline: "Not authenticated",
      detail: "Run codex login.",
    });
  });

  it("never reads ready beside a headline that reports a problem", () => {
    for (const change of [
      { auth: { status: "unauthenticated" } },
      { installed: false },
      { availability: "unavailable" },
    ] as const) {
      expect.soft(deriveProviderStatus({ ...provider, ...change }).key).not.toBe("ready");
    }
  });
});

describe("Antigravity with unchecked sign-in", () => {
  const unchecked: ServerProvider = {
    ...provider,
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    auth: { status: "unknown" },
    message: "Antigravity is installed. Google account access is not checked yet.",
  };

  it("presents an unchecked Google sign-in neutrally without claiming authentication is required", () => {
    for (const auth of [unchecked.auth, { status: "unknown", type: "oauth-personal" }] as const) {
      const candidate = { ...unchecked, auth };
      expect(deriveProviderStatus(candidate)).toEqual({
        key: "neutral",
        headline: "Installed · Sign-in not checked",
        detail: unchecked.message,
      });
    }
  });

  // regression: #18623 neutral unchecked-sign-in display must not mask real warnings
  it("preserves actionable warnings, failures and disabled states outside unchecked Google sign-in", () => {
    const cases = [
      {
        name: "confirmed sign-out",
        change: { auth: { status: "unauthenticated" } },
        headline: "Not authenticated",
        status: "warning",
      },
      {
        name: "warning despite known authentication",
        change: { auth: { status: "authenticated" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "probe failure",
        change: { status: "error" },
        headline: "Unavailable",
        status: "error",
      },
      {
        name: "missing CLI",
        change: { installed: false },
        headline: "Not found",
        status: "warning",
      },
      {
        name: "API key authentication",
        change: { auth: { status: "unknown", type: "gemini-api-key" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "Agent Platform authentication",
        change: { auth: { status: "unknown", type: "agent-platform" } },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "another provider",
        change: { driver: provider.driver },
        headline: "Needs attention",
        status: "warning",
      },
      {
        name: "disabled provider",
        change: { enabled: false },
        headline: "Disabled",
        status: "disabled",
      },
    ] as const;
    for (const { name, change, headline, status } of cases) {
      const candidate = { ...unchecked, ...change };
      const derived = deriveProviderStatus(candidate);
      expect.soft(derived.headline, name).toBe(headline);
      expect.soft(derived.key, name).toBe(status);
    }
  });
});

it("does not suggest copying a command that installs an incompatible latest version", () => {
  const advisory = {
    status: "behind_latest" as const,
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "supported" as const,
    latestVersionStatus: "broken" as const,
    message: null,
    recommendedRange: null,
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, { ...compatibility, status: "broken" }, false),
  ).toBeNull();
  expect(
    getProviderVersionAdvisoryPresentation(advisory, {
      ...compatibility,
      latestVersionStatus: "supported",
    }),
  ).not.toBeNull();
});

it("does not offer an update that cannot change a limited-support version", () => {
  // OpenCode 1.18.35 is the newest `opencode-ai`; the recommended 2.x ships as another package.
  const advisory = {
    status: "current" as const,
    currentVersion: "1.18.35",
    latestVersion: "1.18.35",
    updateCommand: "npm install -g opencode-ai@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "graceful" as const,
    latestVersionStatus: "graceful" as const,
    message: null,
    recommendedRange: ">=2.0.18",
    recommendedVersion: null,
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Limited support",
    detail: "Use >=2.0.18 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
  expect(
    getProviderVersionAdvisoryPresentation(
      { ...advisory, status: "behind_latest", currentVersion: "1.18.34" },
      compatibility,
    )?.updateCommand,
  ).toBe(advisory.updateCommand);
});

it("shows compatibility in the version popover even when the installed version is current", () => {
  const advisory = {
    status: "current" as const,
    currentVersion: "2.0.0",
    latestVersion: "2.0.0",
    updateCommand: "npm install -g fixture@latest",
    canUpdate: true,
    checkedAt: provider.checkedAt,
    message: null,
  };
  const compatibility = {
    status: "broken" as const,
    latestVersionStatus: "broken" as const,
    message: "This version drops turns. Use 1.9.0.",
    recommendedRange: null,
    recommendedVersion: "1.9.0",
  };
  expect(getProviderVersionAdvisoryPresentation(advisory, compatibility)).toEqual({
    title: "Known broken version",
    detail: compatibility.message,
    updateCommand: null,
    emphasis: "strong",
    targetVersion: "1.9.0",
  });
  expect(
    getProviderVersionAdvisoryPresentation(undefined, {
      ...compatibility,
      status: "graceful",
      recommendedVersion: null,
      recommendedRange: ">=2.1.0",
      message: null,
    }),
  ).toEqual({
    title: "Limited support",
    detail: "Use >=2.1.0 for full support.",
    updateCommand: null,
    emphasis: "normal",
    targetVersion: null,
  });
});

it("is the only provider status reading any renderer uses", () => {
  const webSource = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../..",
  );
  const renderers: string[] = [];
  const rawReaders: string[] = [];
  for (const entry of NodeFS.readdirSync(webSource, { recursive: true })) {
    const file = String(entry).split(NodePath.sep).join("/");
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    if (file === "components/settings/providerStatus.ts") continue;
    const source = NodeFS.readFileSync(NodePath.join(webSource, file), "utf8");
    if (!/\bderiveProviderStatus\(/.test(source)) continue;
    renderers.push(file);
    // A renderer that also reads the raw state can disagree with the derivation it imports.
    if (
      /\.status [!=]== "(?:ready|warning|error|disabled)"|\b(?:provider|snapshot|status)\.status\b/.test(
        source,
      )
    )
      rawReaders.push(file);
  }
  expect(rawReaders).toEqual([]);
  expect(renderers.toSorted()).toEqual([
    "components/chat/ModelPickerSidebar.tsx",
    "components/chat/ProviderStatusBanner.tsx",
    "components/onboarding/WelcomePage.tsx",
    "components/settings/CodexSetupSection.tsx",
    "components/settings/ProviderInstanceCard.tsx",
    "components/sidebar/sidebarNavRailCounts.ts",
  ]);
});
