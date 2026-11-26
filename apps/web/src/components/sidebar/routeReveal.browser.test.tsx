import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  resolveSidebarRouteReveal,
  type SidebarRouteReveal,
  useActiveRowReveal,
  useCollapsedRouteAncestors,
} from "./routeReveal";

const ROW_HEIGHT_PX = 24;

function AncestorDisclosure({ routeKey }: { routeKey: string }) {
  const [collapsed, setCollapsed] = useCollapsedRouteAncestors(routeKey);
  return (
    <button
      aria-expanded={!collapsed.has("parent")}
      onClick={() => setCollapsed(new Set(["parent"]))}
    >
      Parent
    </button>
  );
}

function RevealList(props: {
  readonly reveal: SidebarRouteReveal;
  readonly rowKeys: ReadonlyArray<string>;
  readonly activeKey: string | null;
}) {
  const revealActiveRow = useActiveRowReveal(props.reveal, props.activeKey);
  return (
    <ul aria-label="Threads" style={{ height: ROW_HEIGHT_PX * 4, overflowY: "auto", margin: 0 }}>
      {props.rowKeys.map((key) => (
        <li
          key={key}
          ref={key === props.activeKey ? revealActiveRow : undefined}
          tabIndex={-1}
          style={{ height: ROW_HEIGHT_PX }}
        >
          {key}
        </li>
      ))}
    </ul>
  );
}

// The sidebar resolves the reveal in the same render that mounts the row.
function ResolvingRevealList(props: {
  readonly reveal: SidebarRouteReveal;
  readonly rowKeys: ReadonlyArray<string>;
  readonly activeKey: string;
  readonly sectionRowKey?: string;
  readonly listed: boolean;
  readonly onResolved: (widensScope: boolean) => void;
}) {
  const hidden = { projectId: "other" };
  const { widensScope } = resolveSidebarRouteReveal({
    reveal: props.reveal,
    routeKey: props.activeKey,
    sectionRowKey: props.sectionRowKey ?? props.activeKey,
    isSearching: false,
    scopedProjectKeys: new Set(["project"]),
    delegatedUnderParent: new Set(),
    findThread: () => hidden as never,
    listsThread: () => props.listed,
  });
  props.onResolved(widensScope);
  return <RevealList reveal={props.reveal} rowKeys={props.rowKeys} activeKey={props.activeKey} />;
}

const rowKeys = (count: number) => Array.from({ length: count }, (_, index) => `thread-${index}`);
const newReveal = (): SidebarRouteReveal => ({
  observedKey: null,
  pendingKey: null,
  widenedKey: null,
});

describe("useActiveRowReveal", () => {
  it("reopens an ancestor after leaving and returning to its child", async () => {
    await using screen = await render(
      <AncestorDisclosure routeKey="child-a" />,
      // The route arrives through props.
      { router: false },
    );
    const parent = screen.getByRole("button", { name: "Parent" });
    await parent.click();
    await expect.element(parent).toHaveAttribute("aria-expanded", "false");
    await screen.rerender(<AncestorDisclosure routeKey="child-b" />);
    await screen.rerender(<AncestorDisclosure routeKey="child-a" />);
    await expect.element(parent).toHaveAttribute("aria-expanded", "true");
  });
  it("scrolls an off-screen sibling into view when its route opens under the same section row", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    const sibling = (activeKey: string) => (
      <ResolvingRevealList
        reveal={reveal}
        rowKeys={keys}
        activeKey={activeKey}
        sectionRowKey="parent"
        listed
        onResolved={() => {}}
      />
    );
    await using screen = await render(
      sibling("thread-0"),
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    await expect.element(target).not.toBeInViewport();

    await screen.rerender(sibling("thread-40"));

    await expect.element(target).toBeInViewport();
  });

  it("leaves the list where it is when the user clicked the row that opened the thread", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await userEvent.hover(screen.getByText("thread-2", { exact: true }));
    // Even a no-op scroll forces a layout of the thread being opened.
    using scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-2" />);

    await vi.waitFor(() => expect(reveal.pendingKey).toBeNull());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("reveals a focused row scrolled out of view when the keyboard opens its thread", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    target.element().focus({ preventScroll: true });
    await expect.element(target).not.toBeInViewport();

    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("reveals the active row when it mounts after the shells arrive", async () => {
    const reveal = newReveal();
    // The route already names the thread, but its environment's shells have not
    // listed it yet.
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={rowKeys(5)} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await expect.element(screen.getByText("thread-4", { exact: true })).toBeInTheDocument();

    await screen.rerender(
      <RevealList reveal={reveal} rowKeys={rowKeys(50)} activeKey="thread-40" />,
    );

    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
  });

  it("reveals a thread reopened after a thread whose row never mounted", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    const target = screen.getByText("thread-40", { exact: true });
    await expect.element(target).toBeInViewport();
    screen.getByRole("list", { name: "Threads" }).element().scrollTop = 0;
    await expect.element(target).not.toBeInViewport();

    // The route moves to a thread the list does not hold yet, then back.
    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-99" />);
    await screen.rerender(<RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />);

    await expect.element(target).toBeInViewport();
  });

  it("reveals the open thread again when the sidebar remounts on the same route", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    {
      await using screen = await render(
        <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
        // No router: the route arrives as the activeKey prop.
        { router: false },
      );
      await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
    }

    // A remount starts the list at the top; the record outlives it with no reveal pending.
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-40" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
  });

  it("scrolls a row that mounts after an approval resolves elsewhere", async () => {
    const reveal = newReveal();
    const keys = rowKeys(50);
    const widened: boolean[] = [];
    const rows = keys.slice(0, 5);
    await using screen = await render(
      <RevealList reveal={reveal} rowKeys={keys} activeKey="thread-0" />,
      // No router: the route arrives as the activeKey prop.
      { router: false },
    );
    // The thread waits in the Needs you box, so no section row lists it yet.
    await screen.rerender(
      <ResolvingRevealList
        reveal={reveal}
        rowKeys={rows}
        activeKey="thread-40"
        listed={false}
        onResolved={(widensScope) => widened.push(widensScope)}
      />,
    );
    expect(reveal.pendingKey).toBe("thread-40");

    // Another client approves it, and its row mounts in a scope that still hides it.
    await screen.rerender(
      <ResolvingRevealList
        reveal={reveal}
        rowKeys={keys}
        activeKey="thread-40"
        listed
        onResolved={(widensScope) => widened.push(widensScope)}
      />,
    );

    await expect.element(screen.getByText("thread-40", { exact: true })).toBeInViewport();
    expect(widened.every((widensScope) => !widensScope)).toBe(true);
  });
});
