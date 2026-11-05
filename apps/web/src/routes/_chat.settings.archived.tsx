import { createFileRoute, redirect } from "@tanstack/react-router";

// Archived threads left Settings for their own page; keep the project scope of old links.
export const Route = createFileRoute("/_chat/settings/archived")({
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/archived",
      search: {
        ...(search.project ? { project: search.project } : {}),
        ...(search.machine ? { machine: search.machine } : {}),
        ...(search.checkout ? { checkout: search.checkout } : {}),
      },
      replace: true,
    });
  },
});
