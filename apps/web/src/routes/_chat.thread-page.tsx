import { createFileRoute } from "@tanstack/react-router";

import { ThreadPagePage } from "../components/threadPage/ThreadPagePage";
import { isThreadPageUrl } from "../components/threadPage/threadPageLinks";

function ThreadPageRoute() {
  const { url } = Route.useSearch();
  return <ThreadPagePage url={url} />;
}

export const Route = createFileRoute("/_chat/thread-page")({
  // The page's signed-in session must only ever load ThreadPage itself.
  validateSearch: (raw: Record<string, unknown>): { url?: string } =>
    typeof raw.url === "string" && isThreadPageUrl(raw.url) ? { url: raw.url } : {},
  component: ThreadPageRoute,
});
