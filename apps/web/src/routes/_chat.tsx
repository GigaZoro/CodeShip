import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const threadTarget = useThreadRouteTarget();
  return (
    <>
      {threadTarget?.kind === "server" ? (
        <ThreadLinkPrompt threadRef={threadTarget.threadRef} />
      ) : null}
      {threadTarget ? <ThreadRouteView target={threadTarget} /> : <Outlet />}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ params }) => retainThreadFindForRouteMatch(params),
  onStay: ({ params }) => retainThreadFindForRouteMatch(params),
  onLeave: () => retainThreadFindForRoute(null),
});

function retainThreadFindForRouteMatch(
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute(target?.kind === "server" ? target.threadRef : null);
}
