import { createFileRoute, notFound } from "@tanstack/react-router";

// Without this catch-all, /settings/<retired page> fully matches /$environmentId/$threadId and
// opens a thread view, so the settings layout never redirects it.
export const Route = createFileRoute("/_chat/settings/$")({
  beforeLoad: () => {
    throw notFound();
  },
});
