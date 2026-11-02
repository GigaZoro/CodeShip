import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ArtifactsPage } from "../components/artifacts/ArtifactsPage";

export interface ArtifactsSearch {
  readonly environmentId?: EnvironmentId;
  readonly page?: string;
}

function ArtifactsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ArtifactsPage
      selection={
        search.environmentId && search.page
          ? { environmentId: search.environmentId, attachmentId: search.page }
          : null
      }
      onSelectionChange={(selection) =>
        void navigate({
          search: selection
            ? { environmentId: selection.environmentId, page: selection.attachmentId }
            : {},
          replace: true,
          resetScroll: false,
        })
      }
    />
  );
}

export const Route = createFileRoute("/_chat/artifacts")({
  validateSearch: (raw: Record<string, unknown>): ArtifactsSearch => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId.slice(0, 200) as EnvironmentId }
      : {}),
    ...(typeof raw.page === "string" && raw.page ? { page: raw.page.slice(0, 256) } : {}),
  }),
  component: ArtifactsRoute,
});
