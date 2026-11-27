// @effect-diagnostics nodeBuiltinImport:off - reads the real route files on disk.
import * as NodeFS from "node:fs";

import { EnvironmentId, ProviderInstanceId, ScheduledTaskId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { routeTree } from "../../routeTree.gen";
import { resolveSettingsScope } from "./settingsScope";
import {
  redirectMovedSettingsLocation,
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "./settingsScopeNavigation";
import { movedSettingsPath } from "./settingsSearch";

import { validateScheduledTasksSearch } from "./scheduledTasksSettings.logic";

const checkoutSearch = {
  project: "repository:t3code",
  machine: "remote-server",
  checkout: "remote-server:/home/user/T3.CodeShip",
};

function createSettingsRouter(initialEntry = "/settings/general") {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
    search: { middlewares: [retainSettingsScope] },
    beforeLoad: ({ location }) => {
      if (location.pathname === "/settings") {
        throw redirect({ to: "/settings/general", replace: true });
      }
    },
  });
  const general = createRoute({ getParentRoute: () => settings, path: "general" });
  const projects = createRoute({ getParentRoute: () => settings, path: "projects" });
  const browser = createRoute({ getParentRoute: () => settings, path: "browser" });
  const sourceControl = createRoute({ getParentRoute: () => settings, path: "source-control" });
  const providers = createRoute({
    getParentRoute: () => settings,
    path: "providers",
    validateSearch: (raw: Record<string, unknown>) => ({
      ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
        ? { environmentId: EnvironmentId.make(raw.environmentId) }
        : {}),
      ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
        ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
        : {}),
    }),
  });
  const scheduledTasks = createRoute({
    getParentRoute: () => root,
    path: "scheduled-tasks",
    validateSearch: validateScheduledTasksSearch,
  });
  const legacyProject = createRoute({
    getParentRoute: () => root,
    path: "projects/$projectKey",
    beforeLoad: ({ params }) => {
      throw redirect({
        to: "/settings/projects",
        search: { project: params.projectKey, machine: undefined },
        replace: true,
      });
    },
  });
  return createRouter({
    routeTree: root.addChildren([
      settings.addChildren([general, projects, browser, sourceControl, providers]),
      scheduledTasks,
      legacyProject,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("settings scope navigation", () => {
  it("clears a checkout when selecting all environments and all projects", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch, hash: "old-setting" });
    await router.navigate({
      to: "/settings/general",
      search: { project: undefined, machine: undefined, checkout: undefined },
      hash: "",
    });
    expect(router.state.location.search).toEqual({});
    expect(router.state.location.hash).toBe("");
  });

  it("preserves the checkout through category and settings-search navigation", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch, hash: "new-threads" });
    await router.navigate({ to: "/settings/browser", hash: "", replace: true });
    expect(router.state.location.search).toEqual(checkoutSearch);
    expect(router.state.location.hash).toBe("");
    await router.navigate({ to: "/settings/source-control", hash: "source-control-writing-style" });
    expect(router.state.location.search).toEqual(checkoutSearch);
    expect(router.state.location.hash).toBe("source-control-writing-style");
    await router.navigate({ to: "/settings/projects", hash: "project-defaults" });
    expect(router.state.location.search).toEqual(checkoutSearch);
  });

  it.each(["/settings/projects"] as const)(
    "keeps %s when regrouping or selecting a target from the shared settings layout",
    async (to) => {
      const router = createSettingsRouter();
      await router.navigate({ to, search: checkoutSearch });

      const regroupedCheckout = { ...checkoutSearch, project: "separate:t3code" };
      await router.navigate({
        from: "/settings",
        to: router.state.location.pathname,
        search: () => regroupedCheckout,
        replace: true,
        hashScrollIntoView: false,
      });
      expect(router.state.location.pathname).toBe(to);
      expect(router.state.location.search).toEqual(regroupedCheckout);
      expect(router.state.redirect).toBeUndefined();

      await router.navigate({
        from: "/settings",
        to: router.state.location.pathname,
        search: () => ({ machine: "another-server" }),
        hash: "",
        resetScroll: false,
      });
      expect(router.state.location.pathname).toBe(to);
      expect(router.state.location.search).toEqual({ machine: "another-server" });
      expect(router.state.location.hash).toBe("");

      const selectedCheckout = {
        project: "another-project",
        machine: "another-server",
        checkout: "another-server:/home/user/Another checkout",
      };
      await router.navigate({
        from: "/settings",
        to: router.state.location.pathname,
        search: () => selectedCheckout,
        hash: "requested-setting",
      });
      expect(router.state.location.pathname).toBe(to);
      expect(router.state.location.search).toEqual(selectedCheckout);
      expect(router.state.location.hash).toBe("requested-setting");
    },
  );

  it("honors an explicit provider environment and drops its instance on category navigation", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    await router.navigate({
      to: "/settings/providers",
      search: {
        environmentId: EnvironmentId.make("provider-server"),
        instanceId: ProviderInstanceId.make("codex-work"),
      },
    });
    expect(router.state.location.search).toEqual({
      machine: "provider-server",
      environmentId: "provider-server",
      instanceId: "codex-work",
    });
    await router.navigate({ to: "/settings/general", hash: "" });
    expect(router.state.location.search).toEqual({ machine: "provider-server" });
  });

  it("preserves the environment from an initially loaded legacy provider URL", async () => {
    const router = createSettingsRouter(
      "/settings/providers?environmentId=provider-server&instanceId=codex-work",
    );
    await router.load();
    await router.navigate({ to: "/settings/general" });
    expect(router.state.location.search).toEqual({ machine: "provider-server" });
  });

  it("retains an explicit unavailable target rather than reviving the previous environment", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: { machine: "online" } });
    await router.navigate({ to: "/settings/general", search: { machine: "removed" } });
    expect(router.state.location.search).toEqual({ machine: "removed" });
    expect(
      resolveSettingsScope(
        router.state.location.search,
        [],
        [{ environmentId: EnvironmentId.make("online"), label: "Online" }],
      ),
    ).toMatchObject({
      kind: "unavailable",
      reason: "environment-missing",
      environmentIds: [],
    });
  });

  it("preserves escaped checkout identifiers across reload and browser history", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    const checkoutHref = router.state.location.href;
    await router.navigate({ to: "/settings/general", search: { machine: "another" } });
    router.history.back();
    await router.load();
    expect(router.state.location.search).toEqual(checkoutSearch);
    const reloaded = createSettingsRouter(checkoutHref);
    await reloaded.load();
    expect(reloaded.state.location.search).toEqual(checkoutSearch);
    await reloaded.navigate({ to: "/settings/browser", hash: "agent-browser-access" });
    expect(reloaded.state.location.search).toEqual(checkoutSearch);
  });

  it("redirects legacy project links without carrying the prior checkout scope", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings/general", search: checkoutSearch });
    await router.navigate({
      to: "/projects/$projectKey",
      params: { projectKey: "legacy-project" },
    });
    expect(router.state.redirect).not.toBeUndefined();
    await router.navigate(router.state.redirect!.options);
    expect(router.state.location.pathname).toBe("/settings/projects");
    expect(router.state.location.search).toEqual({ project: "legacy-project" });
  });

  it("keeps scope through the settings index redirect", async () => {
    const router = createSettingsRouter();
    await router.navigate({ to: "/settings", search: { machine: "remote-server" } });
    expect(router.state.redirect).not.toBeUndefined();
    await router.navigate(router.state.redirect!.options);
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(router.state.location.search).toEqual({ machine: "remote-server" });
  });
});

describe("scheduled task scope navigation", () => {
  it("opens a task link on its owning environment, then clears the task when changing filters", async () => {
    const router = createSettingsRouter();
    await router.navigate({
      to: "/scheduled-tasks",
      search: {
        environmentId: EnvironmentId.make("remote-server"),
        taskId: ScheduledTaskId.make("task-1"),
      },
    });
    expect(router.state.matches.at(-1)?.search).toEqual({
      machine: "remote-server",
      environmentId: "remote-server",
      taskId: "task-1",
    });
    await router.navigate({
      to: "/scheduled-tasks",
      search: () => ({ machine: undefined, project: undefined, checkout: undefined }),
    });
    expect(router.state.matches.at(-1)?.search).toEqual({});
  });
});

describe("retired settings pages", () => {
  const routesDir = new URL("../../routes/", import.meta.url);
  const settingsRouteFiles = NodeFS.readdirSync(routesDir).filter((name) =>
    /^_chat\.settings\..+\.tsx$/.test(name),
  );

  it.each(settingsRouteFiles)("%s renders a page or redirects on its own", (name) => {
    const source = NodeFS.readFileSync(new URL(name, routesDir), "utf8");
    const path = `/settings/${name.slice("_chat.settings.".length, -".tsx".length)}`;

    expect({ path, ownsContent: /\b(component|beforeLoad)\s*:/.test(source) }).toEqual({
      path,
      ownsContent: true,
    });
    // The settings layout redirects a moved path before its child loads, so a file there is dead.
    expect(movedSettingsPath(path, "")).toBeNull();
  });

  const retiredPages = [
    ["/settings/about", "/settings/maintenance"],
    ["/settings/access", "/settings/connections"],
    ["/settings/beta", "/settings/general"],
    ["/settings/devices", "/settings/browser"],
    ["/settings/diffs", "/settings/chat"],
    ["/settings/integrations", "/settings/browser"],
    ["/settings/labs", "/settings/general"],
    ["/settings/snap-shot", "/settings/chat"],
    ["/settings/storage", "/settings/maintenance"],
    ["/settings/worktrees", "/settings/source-control"],
  ] as const;

  it("routes every saved settings link through the settings layout in the app's route tree", () => {
    const router = createRouter({ routeTree, history: createMemoryHistory() });
    const layoutMatched = (path: string) =>
      router.matchRoutes(path, {}).some((match) => match.routeId === "/_chat/settings");

    // Two-segment paths otherwise fully match /$environmentId/$threadId and skip the redirect.
    expect(
      [...retiredPages.map(([from]) => from), "/settings/unknown"].filter(
        (path) => !layoutMatched(path),
      ),
    ).toEqual([]);
  });

  it.each(retiredPages)("sends a saved %s link without a route file to %s", async (from, to) => {
    const root = createRootRoute();
    const settings = createRoute({
      getParentRoute: () => root,
      path: "settings",
      beforeLoad: ({ location }) => redirectMovedSettingsLocation(location),
    });
    const page = createRoute({
      getParentRoute: () => settings,
      path: to.slice("/settings/".length),
    });
    const router = createRouter({
      routeTree: root.addChildren([settings.addChildren([page])]),
      history: createMemoryHistory({ initialEntries: [to] }),
    });

    await router.navigate({ href: from });

    expect(router.state.redirect?.options).toMatchObject({ to, replace: true });
  });
});
