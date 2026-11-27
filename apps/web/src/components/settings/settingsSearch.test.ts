import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  makeProviderSettingsSchema,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { UNKNOWN_SOURCE_CONTROL_CLIENT } from "@t3tools/client-runtime/source-control-clients";
import { activateLanguage } from "@t3tools/shared/i18n";
import { msg } from "~/i18n";
import * as Schema from "effect/Schema";

import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
  movedSettingsPath,
  consolidatedSettingsAnchor,
  searchSettings,
  settingsNavGroups,
  SETTINGS_SEARCH_ITEMS,
  settingScopeAxesById,
  settingsSearchItemTitle,
  sourceControlHostSearchItems,
  sourceControlHostSettingsSearchId,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: msg("Word wrap"),
    to: "/settings/general",
    searchTerms: ["long lines in code previews"],
  },
  {
    id: "network-access",
    title: msg("Network access"),
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: msg("Providers"),
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: msg("Update checks"),
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: msg("Automatic updates"),
    to: "/settings/general",
  },
];

describe("consolidated setting links", () => {
  it.each([
    ["auto-resume-limited-threads", "usage-limit-recovery"],
    ["snooze-limited-threads", "usage-limit-recovery"],
    ["in-app-notifications", "thread-notifications"],
    ["provider-update-checks", "provider-updates"],
    ["auto-update-providers", "provider-updates"],
  ])("redirects %s to %s", (legacy, current) => {
    expect(consolidatedSettingsAnchor(legacy)).toBe(current);
  });
  it("moves the old maintenance Diagnostics links to Diagnostics", () => {
    expect(movedSettingsPath("/settings/maintenance", "diagnostics")).toBe("/settings/diagnostics");
    expect(movedSettingsPath("/settings/maintenance", "diagnostics-section")).toBe(
      "/settings/diagnostics",
    );
  });
});

describe("searchSettings", () => {
  it("matches titles, sections, and remembered setting details", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("machines", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
    expect(searchSettings("long lines", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    activateLanguage({
      language: "uk",
      catalog: { "Word wrap": "Ajuste de línea" },
      formattingLocale: undefined,
    });
    try {
      expect(searchSettings("ajuste", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    } finally {
      activateLanguage({ language: "en", catalog: {}, formattingLocale: undefined });
    }
    for (const query of ["fallback", "fallback agent", "fallback model"]) {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "fallback-model",
        to: "/settings/providers",
        scope: "environment-defaults",
      });
    }
  });

  it("sends pages that moved out of Settings to their own page", () => {
    expect(searchSettings("scheduled tasks")[0]).toMatchObject({ to: "/scheduled-tasks" });
    expect(searchSettings("automations")[0]).toMatchObject({ to: "/scheduled-tasks" });
    expect(searchSettings("scheduled tasks model")[0]).toMatchObject({
      id: "scheduled-task-model",
      to: "/settings/providers",
    });
    for (const query of ["mcp", "MCP servers", "model context"]) {
      expect(searchSettings(query)[0]).toMatchObject({ to: "/extensions", extensionsTab: "mcp" });
    }
    expect(searchSettings("plugins")[0]).toMatchObject({
      to: "/extensions",
      extensionsTab: "plugins",
    });
  });

  it("finds the differences between machines", () => {
    for (const query of ["differences", "compare machines", "same settings everywhere"]) {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "machine-setting-differences",
        to: "/settings/connections",
      });
    }
  });

  it.each([
    { scenario: "shows Secrets by default", flag: undefined, visible: true },
    { scenario: "shows Secrets with a blank build flag", flag: "  ", visible: true },
    { scenario: "hides Secrets with a zero build flag", flag: "0", visible: false },
    { scenario: "hides Secrets with a false build flag", flag: " false ", visible: false },
  ])("$scenario in navigation and 1Password search", async ({ flag, visible }) => {
    vi.resetModules();
    vi.stubEnv("T3CODE_FEATURE_SECRETS", flag);

    try {
      const { settingsNavGroups, filterAvailableSettingsSearchItems } =
        await import("./settingsSearch");

      expect({
        navigation: settingsNavGroups(true).some((group) =>
          group.paths.includes("/settings/secrets"),
        ),
        search: filterAvailableSettingsSearchItems({
          hasEnvironment: true,
          hasCloudPublicConfig: false,
          hasProviderSettingsEnvironment: true,
          canManageLocalBackend: false,
          isWslSettingsRowVisible: false,
          hasThreadAutoSettlement: false,
          hasSecretProvidersEnvironment: true,
        }).some((item) => item.to === "/settings/secrets"),
      }).toEqual({ navigation: visible, search: visible });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("shows the Secrets page in nav and search only when an environment enables secret providers", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    for (const enabled of [false, true]) {
      const navPaths = settingsNavGroups(enabled).flatMap((group) => group.paths);
      const searchPaths = searchSettings(
        "1password",
        filterAvailableSettingsSearchItems({
          ...availability,
          hasSecretProvidersEnvironment: enabled,
        }),
      ).map((item) => item.to);
      expect(navPaths.includes("/settings/secrets")).toBe(enabled);
      expect(searchPaths.includes("/settings/secrets")).toBe(enabled);
    }
  });

  it("finds where subagents and side chats open by any of its names", () => {
    for (const query of ["side panel", "subagent", "side chat", "linked thread", "middle click"]) {
      expect(searchSettings(query).map((item) => item.id)).toContain("side-thread-open-target");
    }
  });

  it("finds the Scheduled tasks page", () => {
    expect(searchSettings("scheduled tasks")[0]).toMatchObject({
      id: "scheduled-tasks-page",
      to: "/scheduled-tasks",
    });
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("panel animations").map((item) => item.id)).toEqual(["panel-animations"]);
    expect(searchSettings("thè\u{1ab0}mes")[0]?.id).toBe("theme");
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase").mockReturnValue("gıt");
    try {
      expect(searchSettings("GIT")[0]?.id).toBe("git-fetch-interval");
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("hold to quit")).toEqual([]);
    expect(searchSettings("wsl")).toEqual([]);
    expect(searchSettings("update track")).toEqual([]);
  });

  it("hides settings whose controls are unavailable", () => {
    const available = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: false,
      hasProviderSettingsEnvironment: false,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    });

    const gatedIds = new Set<string>([
      "follow-change-request-templates",
      "git-fetch-interval",
      "network-access",
      "publish-agent-activity",
      "provider-health-check-interval",
      "source-control-writer-model",
      "review-guide-model",
      "review-guide-instructions",
      "source-control-writing-style",
      "t3-connect",
      "hold-webhooks-while-offline",
      "tailscale-https",
      "wsl-backend",
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "auto-settle-scheduled-threads",
      "days-before-auto-settle",
      "linked-environments",
      "agent-feedback",
    ]);
    expect(available.map((item) => item.id).filter((id) => gatedIds.has(id))).toEqual([]);
  });

  it("finds linked environments on a remote host without local maintenance access", () => {
    const availability = {
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      localEnvironmentDisabled: true,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const results = (hasPeerLinkHost: boolean) =>
      searchSettings(
        "linked environments",
        filterAvailableSettingsSearchItems({ ...availability, hasPeerLinkHost }),
      );
    expect(results(false).map((item) => item.id)).not.toContain("linked-environments");
    expect(results(true)).toContainEqual(
      expect.objectContaining({
        id: "linked-environments",
        to: "/settings/connections",
        targetId: "linked-environments",
      }),
    );
  });

  it("finds the Welcome page only where a primary computer can open it", () => {
    const availability = {
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: false,
    };
    const ids = (hasPrimaryEnvironment: boolean) =>
      searchSettings(
        "welcome page",
        filterAvailableSettingsSearchItems({ ...availability, hasPrimaryEnvironment }),
      ).map((item) => item.id);
    // Hosted web reaches remote computers but has no primary one to set up.
    expect(ids(false)).not.toContain("welcome-page");
    expect(ids(true)).toContain("welcome-page");
  });

  it("finds keybinding commands by label, command id, and default key", () => {
    expect(searchSettings("toggle sidebar")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("sidebar.toggle")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("mod+b")[0]?.id).toBe("keybinding-sidebar.toggle");
    expect(searchSettings("copy link")[0]).toMatchObject({
      id: "keybinding-thread.copyReference",
      to: "/settings/keybindings",
    });
  });

  it("sends commands without a default binding to the section", () => {
    expect(searchSettings("composer.cycleHost")[0]).toMatchObject({
      id: "keybinding-composer.cycleHost",
      targetId: "keybindings",
    });
    expect(searchSettings("sidebar.toggle")[0]?.targetId).toBeUndefined();
  });

  it("finds rows by the titles shown on their pages", () => {
    for (const [title, id] of [
      ["Automatic worktree cleanup", "storage-worktrees"],
      ["Delete settled worktrees", "storage-worktrees"],
      ["Delete old browser artifacts", "storage-artifacts"],
      ["Delete old rotated logs", "storage-artifacts"],
      ["Custom search URL", "browser-search-engine"],
      ["Native sessions", "providers"],
      ["CODEX_HOME path", "providers"],
      ["Shadow home path", "providers"],
      ["Default for new threads", "default-model"],
      ["Use the last picked model", "last-picked-model"],
      ["Fallback model", "fallback-model"],
      ["Auto mode", "auto-mode"],
      ["Titles and background text", "text-generation-model"],
      ["Commit and pull request writing", "source-control-writing-style"],
      ["Commit and pull request writing model", "source-control-writer-model"],
      ["Final review", "final-review"],
      ["Delegated tasks", "delegated-task-models"],
    ] as const) {
      expect(searchSettings(title)[0]?.id, title).toBe(id);
    }
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("setting scope axes", () => {
  it.each([
    ["telemetry-export", "one-machine"],
    ["automated-start-memory-guard", "one-machine"],
    ["provider-updates", "machine"],
    ["fallback-model", "machine"],
    // Placement is per machine with an all-machines default, not one machine's value.
    ["scheduled-task-default-placement", "machine"],
    ["response-streaming", "project"],
    ["skill-availability", "project"],
    // A section whose rows each carry their own pill shows none on its heading.
    ["project-defaults", null],
    ["pull-request-links-open-in-app", null],
    ["sidebar-grouping", null],
    ["sidebar-group-by-machine", null],
  ] as const)("%s varies by %s", (id, axes) => {
    expect(settingScopeAxesById(id)).toBe(axes);
  });
});

describe("auto-settlement search availability", () => {
  function environment(id: string, { connected = true, loaded = true } = {}) {
    return {
      environmentId: EnvironmentId.make(id),
      connection: { phase: connected ? ("connected" as const) : ("offline" as const) },
      serverConfig: loaded ? { environment: { capabilities: {} } } : null,
    };
  }

  const capable = environment("capable");
  const offline = environment("offline", { connected: false });
  const loading = environment("loading", { loaded: false });
  const environments = [capable, offline, loading];

  it("keeps results discoverable when one connected environment supports them", () => {
    const availability = getThreadAutoSettlementSearchAvailability(environments);
    expect(availability.eligibleEnvironmentIds).toEqual([capable.environmentId]);
    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: false,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      canManageLocalBackend: false,
      isWslSettingsRowVisible: false,
      hasThreadAutoSettlement: availability.eligibleEnvironmentIds.length > 0,
    });
    expect(searchSettings("auto-settle", items).map((item) => item.id)).toEqual([
      "auto-settle-inactive-threads",
      "auto-settle-merged-threads",
      "auto-settle-scheduled-threads",
      "days-before-auto-settle",
      "auto-settle-opens-pull-requests",
      "keep-threads-with-pull-requests",
    ]);
  });
});

describe("source control host search items", () => {
  const definition = {
    ...UNKNOWN_SOURCE_CONTROL_CLIENT,
    kind: SourceControlProviderKind.make("example"),
    label: "Example",
    searchKeywords: ["sample"],
    settings: makeProviderSettingsSchema({ apiToken: Schema.String }),
  };

  it("lists a host by its label, its keywords, and its settings fields", () => {
    const items = sourceControlHostSearchItems([UNKNOWN_SOURCE_CONTROL_CLIENT, definition]);
    expect(items.map(settingsSearchItemTitle)).toEqual(["Example credentials"]);
    expect(searchSettings("sample apitoken", items).map((item) => item.id)).toEqual([
      sourceControlHostSettingsSearchId("example"),
    ]);
  });

  it("lists a host with credentials by its accounts, token and CLI", () => {
    const items = sourceControlHostSearchItems([
      {
        ...definition,
        credentials: {
          cliName: "ex",
          cliLabel: "Example CLI",
          loginCommand: "ex login",
          tokenEnvVar: "EX_TOKEN",
          tokenAccess: "access",
          newTokenUrl: (host) => `https://${host}/tokens`,
        },
      },
    ]);
    expect(items.map(settingsSearchItemTitle)).toEqual(["Example accounts and token"]);
    expect(searchSettings("ex switch accounts", items)).toHaveLength(1);
  });

  it("finds the built-in hosts by their own words", () => {
    expect(searchSettings("codeberg").map((item) => item.id)).toContain("source-control");
    expect(searchSettings("ghes").map((item) => item.id)).toContain(
      sourceControlHostSettingsSearchId("github"),
    );
  });
});

describe("movedSettingsPath", () => {
  it("sends old links to the page their row moved to", () => {
    expect(movedSettingsPath("/settings/general", "text-generation-model")).toBe(
      "/settings/providers",
    );
    expect(movedSettingsPath("/settings/threads", "default-model")).toBe("/settings/providers");
    expect(movedSettingsPath("/settings/source-control", "source-control-models")).toBe(
      "/settings/providers",
    );
    expect(movedSettingsPath("/settings/access", "authorized-clients")).toBe(
      "/settings/connections",
    );
    expect(movedSettingsPath("/settings/worktrees", "worktree-branch-naming")).toBe(
      "/settings/source-control",
    );
    expect(movedSettingsPath("/settings/diffs", "diff-color-scheme")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/appearance", "diff-color-scheme")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/appearance", "thread-details-items")).toBe(
      "/settings/chat",
    );
    expect(movedSettingsPath("/settings/appearance", "agent-actions")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/appearance", "math-rendering")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/access", "network-access")).toBe("/settings/connections");
    expect(movedSettingsPath("/settings/storage", "storage-worktrees")).toBe(
      "/settings/maintenance",
    );
    expect(movedSettingsPath("/settings/storage", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/integrations", "devices")).toBe("/settings/browser");
    expect(movedSettingsPath("/settings/beta", "")).toBe("/settings/general");
    expect(movedSettingsPath("/settings/labs", "guest-links")).toBe("/settings/connections");
    expect(movedSettingsPath("/settings/about", "")).toBe("/settings/maintenance");
    expect(movedSettingsPath("/settings/snap-shot", "")).toBe("/settings/chat");
    expect(movedSettingsPath("/settings/chat", "send-shortcut")).toBe("/settings/keybindings");
    expect(movedSettingsPath("/settings/providers", "compact-idle-threads")).toBe(
      "/settings/threads",
    );
    for (const anchor of [
      "continue-threads-after-server-update",
      "retry-threads-after-network-errors",
    ]) {
      expect(movedSettingsPath("/settings/maintenance", anchor)).toBe("/settings/threads");
    }
    for (const anchor of [
      "storage-worktrees",
      "storage-worktree-keep-when",
      "storage-cleanup",
      "storage-artifacts",
    ]) {
      expect(movedSettingsPath("/settings/source-control", anchor)).toBe("/settings/maintenance");
    }
    expect(movedSettingsPath("/settings/providers", "provider-health-check-interval")).toBe(
      "/settings/maintenance",
    );
    expect(movedSettingsPath("/settings/source-control", "git-fetch-interval")).toBe(
      "/settings/maintenance",
    );
    expect(movedSettingsPath("/settings/threads", "usage-limits")).toBeNull();
    expect(consolidatedSettingsAnchor("usage-limits")).toBe("recovery");
  });

  it("leaves current pages alone", () => {
    expect(movedSettingsPath("/settings/general", "time-format")).toBeNull();
    expect(movedSettingsPath("/settings/projects", "add-project-starts-in")).toBeNull();
    expect(movedSettingsPath("/settings/connections", "remote-environments")).toBeNull();
    expect(movedSettingsPath("/settings/appearance", "theme")).toBeNull();
    expect(movedSettingsPath("/settings/appearance", "effort-display")).toBeNull();
    expect(movedSettingsPath("/settings/providers", "default-model")).toBeNull();
  });
});
