import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  getProviderStatusNoticeKey,
  getProviderStatusMessage,
  shouldShowProviderStatusNotice,
} from "./ProviderStatusBanner";

const healthy: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-22T00:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
};

const provider: ServerProvider = {
  ...healthy,
  compatibilityAdvisory: {
    status: "unsupported",
    message: "Unsupported version. Use 2.0.0.",
    recommendedVersion: "2.0.0",
    recommendedRange: null,
  },
};

describe("compatibility notices", () => {
  it("shows and dismisses a warning on a healthy provider, then clears it after policy relaxation", () => {
    expect(shouldShowProviderStatusNotice(provider, null)).toBe(true);
    expect(shouldShowProviderStatusNotice(provider, getProviderStatusNoticeKey(provider))).toBe(
      false,
    );
    expect(
      shouldShowProviderStatusNotice(
        { ...provider, version: "1.0.1" },
        getProviderStatusNoticeKey(provider),
      ),
    ).toBe(true);
    const relaxed: ServerProvider = {
      ...provider,
      compatibilityAdvisory: {
        ...provider.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(getProviderStatusNoticeKey(relaxed)).toBeNull();
    expect(getProviderStatusNoticeKey({ ...provider, status: "disabled" })).toBeNull();
    expect(
      getProviderStatusNoticeKey({
        ...provider,
        compatibilityAdvisory: { ...provider.compatibilityAdvisory!, status: "graceful" },
      }),
    ).toBeNull();
  });

  it("shows downgrade guidance instead of a broken OpenCode inventory timeout", () => {
    const message = "This provider version is known to be incompatible. Use 1.14.19.";
    const broken: ServerProvider = {
      ...provider,
      driver: ProviderDriverKind.make("opencode"),
      version: "2.0.3",
      status: "error",
      auth: { status: "unknown" },
      message: "Failed to load OpenCode provider inventory: Timed out waiting for server start.",
      compatibilityAdvisory: {
        status: "broken",
        message,
        recommendedVersion: "1.14.19",
        recommendedRange: ">=1.14.19 <2.0.0",
      },
    };
    expect(shouldShowProviderStatusNotice(broken, null)).toBe(true);
    const timeoutOnly: ServerProvider = {
      ...broken,
      compatibilityAdvisory: {
        ...broken.compatibilityAdvisory!,
        status: "supported",
        message: null,
      },
    };
    expect(shouldShowProviderStatusNotice(broken, getProviderStatusNoticeKey(timeoutOnly))).toBe(
      true,
    );
    expect(shouldShowProviderStatusNotice(broken, getProviderStatusNoticeKey(broken))).toBe(false);
    expect(
      shouldShowProviderStatusNotice(
        {
          ...broken,
          compatibilityAdvisory: { ...broken.compatibilityAdvisory!, message: "Use 1.14.20." },
        },
        getProviderStatusNoticeKey(broken),
      ),
    ).toBe(true);
    expect(getProviderStatusMessage(broken)).toBe(message);
    expect(
      getProviderStatusMessage({
        ...broken,
        compatibilityAdvisory: {
          ...broken.compatibilityAdvisory!,
          status: "supported",
          message: null,
        },
      }),
    ).toBe(broken.message);
    expect(getProviderStatusMessage({ ...broken, auth: { status: "unauthenticated" } })).toBe(
      broken.message,
    );
  });
});

describe("provider status notices", () => {
  const antigravity: ServerProvider = {
    ...healthy,
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "warning",
    auth: { status: "unknown" },
  };

  it("reports in the thread exactly what settings reports as needing attention", () => {
    expect(getProviderStatusNoticeKey(antigravity)).toBeNull();
    expect(
      getProviderStatusNoticeKey({
        ...antigravity,
        auth: { status: "unknown", type: "gemini-api-key" },
      }),
    ).not.toBeNull();
    expect(getProviderStatusNoticeKey({ ...healthy, availability: "unavailable" })).not.toBeNull();
    expect(getProviderStatusNoticeKey({ ...healthy, enabled: false })).toBeNull();
  });
});
