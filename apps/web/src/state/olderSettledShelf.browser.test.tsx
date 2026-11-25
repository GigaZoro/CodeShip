import { useAtomValue } from "@effect/atom-react";
import {
  hasMoreSettledMatches,
  type OlderSettledScope,
  type OlderSettledShelfEnvironment,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useSidebarThreads } from "../components/Sidebar";
import { makeThreadFixture } from "../test-fixtures";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { olderSettledThreads, threadFamilies } from "./threads";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "./olderSettledShelf";

const environmentId = EnvironmentId.make("env-a");
const first = ProjectId.make("project-a");
const second = ProjectId.make("project-b");

function Shelf(props: {
  readonly scopes: ReadonlyArray<OlderSettledScope>;
  readonly filtered?: boolean;
  readonly matches?: readonly EnvironmentThreadShell[];
}) {
  const shelf = useOlderSettledShelf({
    scopes: props.scopes,
    expanded: true,
    visibleCount: props.filtered === undefined ? 0 : 10,
    filtered: props.filtered ?? false,
  });
  const matches = props.matches ?? [];
  const listed = matches.filter(shelf.isListed);
  const shown = listed.slice(0, shelf.visibleCount);
  useOlderSettledShelfGrowth([{ shelf, listedCount: listed.length }]);
  return (
    <>
      <output>{shelf.pages.get(environmentId) ?? 0}</output>
      <button type="button" onClick={() => shelf.grow(new Map([[environmentId, 1]]))}>
        Grow
      </button>
      <ul aria-label={`Settled (${matches.length})`}>
        {shown.map((thread) => (
          <li key={thread.id}>{thread.title}</li>
        ))}
      </ul>
      {hasMoreSettledMatches(shelf.hasMorePages, matches.length, shown.length) ? (
        <button type="button" onClick={() => shelf.showMoreFiltered(shown.length, listed.length)}>
          Show more
        </button>
      ) : null}
    </>
  );
}

describe("useOlderSettledShelf", () => {
  it("resets chat folder previews when the project or tag filter changes", async () => {
    const threads = Array.from({ length: 35 }, (_, index) => {
      const thread = makeThreadFixture({ id: ThreadId.make(`filed-${index}`), environmentId });
      return presentThreadShell(environmentId, {
        ...thread.source,
        folder: "Autopilot",
        tags: ["work"],
      });
    });
    const pageThreads = Array.from({ length: 3 }, (_, index) => {
      const thread = makeThreadFixture({
        id: ThreadId.make(`older-filed-${index}`),
        environmentId,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      });
      return presentThreadShell(environmentId, {
        ...thread.source,
        folder: "Autopilot",
        tags: ["work"],
      });
    });
    const pageMounted = Atom.make(false);
    function FolderView({
      projectScopeKey,
      filtered = false,
      hasServer = false,
      activeCount = 7,
    }: {
      projectScopeKey: string;
      filtered?: boolean;
      hasServer?: boolean;
      activeCount?: number;
    }) {
      const hasPage = useAtomValue(pageMounted);
      const list = useSidebarThreads({
        projectScopeKey,
        scopedProjectKeys: null,
        statusFilter: "all",
        tagFilter: new Set(filtered ? ["work"] : []),
        sort: "default",
        lastActivityOrder: new Map(),
        locallyUnreadKeys: new Set(),
        serverConfigs: new Map(hasServer ? [[environmentId, {} as EnvironmentServerConfig]] : []),
        connectedEnvironmentIds: [environmentId],
        optimisticDrop: null,
        threads: [...threads.slice(0, activeCount), ...(hasPage ? pageThreads : [])],
        delegatedUnderParent: new Set(),
        hiddenTaskThreadKeys: new Set(),
        routeRowThreadKey: null,
        grouping: { projects: null, machines: null },
        nowMs: Date.parse("2026-11-22T00:00:00.000Z"),
      });
      const folder = list.userFolders[0]!;
      return (
        <>
          <output>{folder.threads.length}</output>
          {folder.more?.state === "show" || folder.more?.state === "less" ? (
            <button type="button" onClick={() => list.toggleFolderOverflow(folder.key)}>
              {folder.more.state === "less" ? "Show less" : "Show more"}
            </button>
          ) : null}
        </>
      );
    }
    const before = "2026-01-02T00:00:00.000Z";
    const folderShelf = (status: "ready" | "failed", exhausted = false) =>
      Atom.make([
        new Map<EnvironmentId, OlderSettledShelfEnvironment>([
          [
            environmentId,
            {
              older: {
                before,
                beforeMs: Date.parse(before),
                counts: new Map([[first, 3]]),
                folders: null,
              },
              unloaded: exhausted ? 0 : 3,
              pages: { reads: [], frontier: exhausted ? null : { settledAt: before }, status },
            },
          ],
        ]),
      ]);
    const ready = folderShelf("ready");
    const failed = folderShelf("failed");
    const exhausted = folderShelf("ready", true);
    const empty = Atom.make<
      ReadonlyArray<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>>
    >([]);
    await using screen = await render(<FolderView projectScopeKey="project-a" />);
    const listed = screen.getByRole("status");
    {
      using shelves = vi
        .spyOn(olderSettledThreads, "shelvesAtom")
        .mockImplementation(([scopes]) =>
          scopes?.[0]?.scope.folder === "autopilot" ? ready : empty,
        );
      await screen.rerender(
        <FolderView projectScopeKey="project-filtered" filtered hasServer activeCount={35} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect.soft(listed.element().textContent).toBe("30");
      expect.soft(shelves.mock.calls.flat(3).some(({ pages }) => pages > 0)).toBe(false);
      await screen.rerender(<FolderView projectScopeKey="project-few" filtered hasServer />);
      await userEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(listed.element().textContent).toBe("7");
      expect(shelves.mock.calls.flat(3).some(({ pages }) => pages === 1)).toBe(true);
      expect(shelves.mock.calls.flat(3).some(({ pages }) => pages > 1)).toBe(false);
    }
    {
      using shelves = vi
        .spyOn(olderSettledThreads, "shelvesAtom")
        .mockImplementation(([scopes]) => {
          const entry = scopes?.[0];
          if (entry?.scope.folder !== "autopilot") return empty;
          return entry.pages > 0 ? exhausted : ready;
        });
      using _mount = vi.spyOn(threadFamilies, "mountRows").mockImplementation((registry) => {
        registry.set(pageMounted, true);
        return () => registry.set(pageMounted, false);
      });
      for (const filtered of [true, false]) {
        await screen.rerender(
          <AppAtomRegistryProvider>
            <FolderView
              projectScopeKey={String(filtered)}
              filtered={filtered}
              hasServer
              activeCount={3}
            />
          </AppAtomRegistryProvider>,
        );
        await expect.element(listed).toHaveTextContent("3");
        await userEvent.click(screen.getByRole("button", { name: "Show more" }));
        await expect.element(listed).toHaveTextContent("6");
        await userEvent.click(screen.getByRole("button", { name: "Show less" }));
        expect.soft(listed.element().textContent).toBe("3");
        expect.soft(shelves.mock.calls.at(-1)?.flat(2)[0]?.pages).toBe(0);
      }
    }
    {
      using _shelves = vi
        .spyOn(olderSettledThreads, "shelvesAtom")
        .mockImplementation(([scopes]) => {
          const entry = scopes?.[0];
          if (entry?.scope.folder !== "autopilot") return empty;
          return entry.pages > 0 ? failed : ready;
        });
      await screen.rerender(<FolderView projectScopeKey="project-failure" hasServer />);
      await userEvent.click(screen.getByRole("button", { name: "Show more" }));
      expect(listed.element().textContent).toBe("7");
      await userEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect.soft(listed.element().textContent).toBe("5");
    }
    await screen.rerender(<FolderView projectScopeKey="project-a" />);
    expect(listed.element().textContent).toBe("5");
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(listed.element().textContent).toBe("7");
    await screen.rerender(<FolderView projectScopeKey="project-b" />);
    expect.soft(listed.element().textContent).toBe("5");

    await screen.rerender(
      <FolderView key="filter-sequence" projectScopeKey="project-b" filtered />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(listed.element().textContent).toBe("7");
    await screen.rerender(<FolderView key="filter-sequence" projectScopeKey="project-b" />);
    expect(listed.element().textContent).toBe("5");
  });

  it("lists a held match when its environment has no older rows left to read", async () => {
    const before = "2026-01-02T00:00:00.000Z";
    const shelves = Atom.make<
      ReadonlyArray<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>>
    >([
      new Map<EnvironmentId, OlderSettledShelfEnvironment>([
        [
          environmentId,
          {
            older: {
              before,
              beforeMs: Date.parse(before),
              counts: new Map([[first, 1]]),
              folders: null,
            },
            unloaded: 0,
            pages: { reads: [], frontier: null, status: "ready" },
          },
        ],
      ]),
    ]);
    using _shelves = vi.spyOn(olderSettledThreads, "shelvesAtom").mockReturnValue(shelves);
    const held = makeThreadFixture({
      environmentId,
      projectId: first,
      title: "Held match",
      settledOverride: "settled",
      settledAt: "2026-01-01T00:00:00.000Z",
    });
    await using screen = await render(
      <Shelf scopes={[{ environmentId, projectIds: [first] }]} filtered matches={[held]} />,
      // The hook host has no links or navigation.
      { router: false },
    );
    expect(screen.getByRole("list", { name: "Settled (1)" }).element().textContent).toBe(
      "Held match",
    );
    await expect.element(screen.getByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("keeps requested pages when the scope's projects reorder", async () => {
    await using screen = await render(
      <Shelf scopes={[{ environmentId, projectIds: [first, second] }]} />,
      // A bare hook host; nothing here links or navigates.
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Grow" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");

    // Loading a page can reorder the sidebar's projects; the shelf must not drop its pages.
    await screen.rerender(<Shelf scopes={[{ environmentId, projectIds: [second, first] }]} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");
  });

  it("reads only on a filtered press and resumes automatic growth when cleared", async () => {
    const before = "2026-01-01T12:00:00.000Z";
    const results = (requested: number) =>
      Atom.make<ReadonlyArray<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>>>([
        new Map<EnvironmentId, OlderSettledShelfEnvironment>([
          [
            environmentId,
            {
              older: { before, beforeMs: Date.parse(before), counts: new Map(), folders: null },
              unloaded: 50,
              pages: {
                reads: [],
                frontier: requested < 3 ? { settledAt: before } : null,
                status: "ready",
              },
            },
          ],
        ]),
      ]);
    const shelves = [results(0), results(1), results(2), results(3)];
    using _shelves = vi
      .spyOn(olderSettledThreads, "shelvesAtom")
      .mockImplementation(([scopes]) => shelves[scopes?.[0]?.pages ?? 0]!);
    const scopes = [{ environmentId, projectIds: [first] }];
    await using screen = await render(<Shelf scopes={scopes} filtered />, {
      // The hook host has no links or navigation.
      router: false,
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent("0");
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("1");
    await screen.rerender(<Shelf scopes={scopes} filtered={false} />);
    await expect.element(screen.getByRole("status")).toHaveTextContent("3");
  });
});
