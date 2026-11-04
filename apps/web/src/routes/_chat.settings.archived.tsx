import { createFileRoute, redirect } from "@tanstack/react-router";

// Archived threads left Settings for their own page.
export const Route = createFileRoute("/_chat/settings/archived")({
  beforeLoad: () => {
    throw redirect({ to: "/archived", replace: true });
  },
});
