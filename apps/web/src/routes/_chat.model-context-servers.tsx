import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/model-context-servers")({
  beforeLoad: () => {
    throw redirect({ to: "/extensions", search: { tab: "mcp" }, replace: true });
  },
});
