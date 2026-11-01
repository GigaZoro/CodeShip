import { createFileRoute, redirect } from "@tanstack/react-router";

// Moved out of Settings; old links and reloaded windows land on the new page.
export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/scheduled-tasks${location.searchStr}`, replace: true });
  },
});
