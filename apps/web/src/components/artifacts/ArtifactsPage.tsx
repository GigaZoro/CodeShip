import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, MessageSquareIcon, SearchIcon, ShapesIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useProviderEntryByEnvironmentAndInstanceId } from "../../hooks/useEnvironmentProviderEntries";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useConnectedEnvironmentIds, useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { HtmlRenderFrame } from "../chat/HtmlRenderFrame";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RelativeTime } from "../RelativeTime";
import { settingsScopeEnvironmentLabel } from "../settings/settingsScopeAxis";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { type Artifact, artifactKey, useArtifacts } from "./artifactsState";

export interface ArtifactSelection {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}

function matchesQuery(artifact: Artifact, query: string) {
  if (query === "") return true;
  return [artifact.title, artifact.threadTitle, artifact.projectTitle ?? ""].some((text) =>
    text.toLocaleLowerCase().includes(query),
  );
}

function ArtifactMeta(props: {
  readonly artifact: Artifact;
  readonly environmentLabel: string | undefined;
}) {
  const { artifact } = props;
  return (
    <span className="min-w-0 truncate">
      {[artifact.threadTitle, artifact.projectTitle, props.environmentLabel]
        .filter((part) => part)
        .join(" · ")}
    </span>
  );
}

function ArtifactRow(props: {
  readonly artifact: Artifact;
  readonly provider: ProviderInstanceEntry | undefined;
  readonly selected: boolean;
  readonly environmentLabel: string | undefined;
  readonly onSelect: () => void;
}) {
  const { artifact, provider } = props;
  return (
    <li>
      <button
        type="button"
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onSelect}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 rounded-md px-2.5 py-2 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          props.selected && "bg-accent",
        )}
      >
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          {provider ? (
            <ProviderInstanceIcon
              driverKind={provider.driverKind}
              displayName={provider.displayName}
              accentColor={provider.accentColor}
              acpRegistryIconUrl={provider.acpRegistryIconUrl}
              size="compact"
              iconClassName="opacity-70"
            />
          ) : (
            <ShapesIcon aria-hidden className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">{artifact.title}</span>
            <span className="shrink-0 text-muted-foreground text-xs">
              <RelativeTime timestamp={artifact.publishedAt} />
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            <ArtifactMeta artifact={artifact} environmentLabel={props.environmentLabel} />
            {artifact.versions > 1 ? (
              <Badge size="sm" variant="secondary" className="shrink-0">
                v{artifact.versions}
              </Badge>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function ArtifactPreview(props: {
  readonly artifact: Artifact;
  readonly environmentLabel: string | undefined;
  readonly onBack: (() => void) | undefined;
}) {
  const { artifact } = props;
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(artifact.environmentId, artifact.threadId);
  return (
    <section aria-label={artifact.title} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 items-center gap-2 border-b px-4 py-2.5">
        {props.onBack ? (
          <Button
            aria-label="Back to artifacts"
            size="icon-sm"
            variant="ghost"
            onClick={props.onBack}
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate font-medium text-sm">{artifact.title}</h2>
          <p className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
            <ArtifactMeta artifact={artifact} environmentLabel={props.environmentLabel} />
            <span aria-hidden>·</span>
            <span className="shrink-0">
              <RelativeTime timestamp={artifact.publishedAt} />
            </span>
            {artifact.archived ? <span className="shrink-0">· Archived thread</span> : null}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(threadRef),
            })
          }
        >
          <MessageSquareIcon />
          Open thread
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          <HtmlRenderFrame
            key={artifactKey(artifact)}
            environmentId={artifact.environmentId}
            htmlRender={artifact}
            threadRef={threadRef}
          />
        </div>
      </ScrollArea>
    </section>
  );
}

function ArtifactListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3 p-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex flex-col gap-1.5 px-2.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function ArtifactsPage(props: {
  readonly selection: ArtifactSelection | null;
  readonly onSelectionChange: (selection: ArtifactSelection | null) => void;
}) {
  const environmentIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const { artifacts, failedEnvironmentIds, isLoading, truncated, refresh } =
    useArtifacts(environmentIds);
  const [query, setQuery] = useState("");
  const narrow = useMediaQuery("max-lg");
  const providerEntries = useProviderEntryByEnvironmentAndInstanceId();
  const foldedQuery = query.trim().toLocaleLowerCase();
  const shown = artifacts.filter((artifact) => matchesQuery(artifact, foldedQuery));
  const labelFor = (environmentId: EnvironmentId) => {
    if (environmentIds.length < 2) return undefined;
    const environment = environments.find((candidate) => candidate.environmentId === environmentId);
    return environment ? settingsScopeEnvironmentLabel(environment, environments) : undefined;
  };
  const picked =
    props.selection === null
      ? undefined
      : artifacts.find(
          (artifact) =>
            artifact.environmentId === props.selection?.environmentId &&
            artifact.attachmentId === props.selection.attachmentId,
        );
  // Wide screens always show a page; narrow ones show the list until one is picked.
  const selected = picked ?? (narrow ? undefined : shown[0]);
  const failedLabels = failedEnvironmentIds.map(
    (environmentId) => labelFor(environmentId) ?? "this machine",
  );

  const list = (
    <div
      className={cn("flex min-h-0 flex-col", narrow ? "flex-1" : "w-80 shrink-0 border-r xl:w-96")}
    >
      <div className="p-3 pb-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search artifacts"
            placeholder="Search artifacts"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </InputGroup>
      </div>
      {failedLabels.length > 0 ? (
        <Alert variant="error" role="status" className="mx-3 mb-2 w-auto">
          <AlertDescription>
            Couldn't load artifacts from {failedLabels.join(", ")}.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={refresh}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        {artifacts.length === 0 && isLoading ? (
          <ArtifactListSkeleton />
        ) : shown.length === 0 && artifacts.length > 0 ? (
          <p className="px-5 py-6 text-muted-foreground text-sm">No artifacts match “{query}”.</p>
        ) : (
          <ul aria-label="Artifacts" className="flex flex-col gap-0.5 px-1.5 pb-3">
            {shown.map((artifact) => (
              <ArtifactRow
                key={artifactKey(artifact)}
                artifact={artifact}
                provider={
                  artifact.providerInstanceId === null
                    ? undefined
                    : providerEntries.get(
                        `${artifact.environmentId}:${artifact.providerInstanceId}`,
                      )
                }
                selected={selected !== undefined && artifactKey(selected) === artifactKey(artifact)}
                environmentLabel={labelFor(artifact.environmentId)}
                onSelect={() =>
                  props.onSelectionChange({
                    environmentId: artifact.environmentId,
                    attachmentId: artifact.attachmentId,
                  })
                }
              />
            ))}
          </ul>
        )}
        {truncated ? (
          <p className="px-5 pb-4 text-muted-foreground text-xs">
            Showing the newest {artifacts.length} pages.
          </p>
        ) : null}
      </ScrollArea>
    </div>
  );

  const empty = artifacts.length === 0 && !isLoading && failedLabels.length === 0;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <WorkspaceBreadcrumb ariaLabel="Artifacts breadcrumb" className="min-w-0 flex-1">
            <WorkspaceBreadcrumbItem current>
              <h1>Artifacts</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {empty ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShapesIcon />
              </EmptyMedia>
              <EmptyTitle>No artifacts yet</EmptyTitle>
              <EmptyDescription>
                Ask an agent for a chart, diagram, or mockup. Each page it publishes shows up here
                with a link back to its thread.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : narrow && selected !== undefined ? (
          <ArtifactPreview
            artifact={selected}
            environmentLabel={labelFor(selected.environmentId)}
            onBack={() => props.onSelectionChange(null)}
          />
        ) : (
          <div className="flex min-h-0 flex-1">
            {list}
            {narrow ? null : selected !== undefined ? (
              <ArtifactPreview
                artifact={selected}
                environmentLabel={labelFor(selected.environmentId)}
                onBack={undefined}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                {isLoading ? null : "Select an artifact to preview it."}
              </div>
            )}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
