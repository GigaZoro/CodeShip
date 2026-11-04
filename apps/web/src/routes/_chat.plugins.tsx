import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/plugins")({
  beforeLoad: () => {
    throw redirect({ to: "/extensions", search: { tab: "plugins" }, replace: true });
  },
});
