import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { Spinner } from "~/components/ui/spinner";
import { ArchiveIcon, ArchiveRestoreIcon, SearchIcon, Trash2Icon } from "lucide-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { makeArchivedThreadsViewKey } from "@t3tools/client-runtime/state/threads";
import {
  type EnvironmentThreadShell,
  presentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { t, tx } from "~/i18n";

const SEARCH_DEBOUNCE_MS = 250;

function projectIdsByEnvironment(
  members: ReadonlyArray<{ readonly environmentId: string; readonly id: ProjectId }>,
) {
  const byEnvironment: Record<string, ProjectId[]> = {};
  for (const member of members) (byEnvironment[member.environmentId] ??= []).push(member.id);
  return byEnvironment;
}

interface ArchivedRow {
  readonly thread: EnvironmentThreadShell;
  readonly project: (OrchestrationProjectShell & { readonly environmentId: EnvironmentId }) | null;
  readonly environmentLabel: string;
}

function showFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : t("An error occurred."),
    }),
  );
}

function ArchivedThreadRow(props: {
  readonly row: ArchivedRow;
  readonly showProject: boolean;
  readonly showEnvironment: boolean;
  readonly onChanged: () => void;
}) {
  const { thread, project, environmentLabel } = props.row;
  const navigate = useNavigate();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const canOperate = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const unarchive = async () => {
    const result = await unarchiveThread(threadRef);
    if (result._tag === "Success") props.onChanged();
    showFailure(result, t("Failed to unarchive thread"));
  };
  const remove = async () => {
    const result = await confirmAndDeleteThread(threadRef, { title: thread.title });
    if (result._tag === "Success") props.onChanged();
    showFailure(result, t("Failed to delete thread"));
  };
  const openContextMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "open", label: t("Open") },
        ...(canOperate
          ? [
              { id: "unarchive", label: t("Unarchive") },
              { id: "delete", label: t("Delete"), destructive: true },
            ]
          : []),
      ],
      position,
    );
    if (clicked === "open") {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    } else if (clicked === "unarchive") {
      await unarchive();
    } else if (clicked === "delete") {
      await remove();
    }
  };

  return (
    <SettingsRow
      onContextMenu={(event) => {
        event.preventDefault();
        const position = { x: event.clientX, y: event.clientY };
        void settlePromise(() => openContextMenu(position)).then((result) =>
          showFailure(result, t("Archived thread action failed")),
        );
      }}
      title={
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(threadRef)}
          className="rounded-sm outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {thread.title}
        </Link>
      }
      description={
        <span className="flex min-w-0 items-center gap-1.5">
          {props.showProject && project ? (
            <>
              <ProjectFavicon project={project} className="size-3.5 shrink-0" />
              <span className="truncate">{project.title}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          {props.showEnvironment ? (
            <>
              <span className="truncate">{environmentLabel}</span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span className="shrink-0">
            {tx("Archived {archived}", {
              archived: <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />,
            })}
          </span>
        </span>
      }
      control={
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canOperate}
            onClick={() => void unarchive()}
          >
            <ArchiveRestoreIcon aria-hidden />
            <span>{t("Unarchive")}</span>
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="icon-sm"
                  disabled={!canOperate}
                  aria-label={t('Delete "{title}"', { title: thread.title })}
                  onClick={() => void remove()}
                />
              }
            >
              <Trash2Icon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup side="top">{t("Delete")}</TooltipPopup>
          </Tooltip>
        </div>
      }
    />
  );
}

export function ArchivedThreadsPanel() {
  const { scope, environments } = useSettingsScope();
  const [query, setQuery] = useState("");
  const searchedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const scopedToProjects = scope.kind === "project" || scope.kind === "checkout";
  const projectIds = scopedToProjects ? projectIdsByEnvironment(scope.members) : undefined;
  const view = { environmentIds: scope.environmentIds, query: searchedQuery, projectIds };
  // More pages stay loaded only for the search and scope they were loaded for.
  const viewKey = makeArchivedThreadsViewKey(view);
  const [loaded, setLoaded] = useState({ viewKey, pages: 1 });
  const pages = loaded.viewKey === viewKey ? loaded.pages : 1;
  const archive = useArchivedThreadSnapshots({ ...view, pages });

  const environmentLabels = new Map(
    environments.map((environment) => {
      const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
      return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
    }),
  );
  const rows: ArchivedRow[] = archive.snapshots
    .flatMap(({ environmentId, snapshot }) => {
      const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
      return snapshot.threads.map((shell) => {
        const project = projects.get(shell.projectId);
        return {
          thread: presentThreadShell(environmentId, shell),
          project: project === undefined ? null : { ...project, environmentId },
          environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
        };
      });
    })
    .toSorted((left, right) => {
      const leftKey = left.thread.archivedAt ?? left.thread.createdAt;
      const rightKey = right.thread.archivedAt ?? right.thread.createdAt;
      return rightKey.localeCompare(leftKey) || left.thread.id.localeCompare(right.thread.id);
    });
  const showEnvironment = new Set(rows.map((row) => row.thread.environmentId)).size > 1;
  const searching = searchedQuery.length > 0;
  const initialLoad = archive.isLoading && rows.length === 0;
  const archiveSetting = searchableSetting("archive");

  const searchField = (
    <InputGroup className="w-44 sm:w-56">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        size="sm"
        aria-label={t("Search archived threads")}
        placeholder={t("Search archived threads")}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || query.length === 0) return;
          event.preventDefault();
          setQuery("");
        }}
      />
    </InputGroup>
  );

  return (
    <SettingsPageContainer scopeLead={t("Showing archived threads for")}>
      <SettingsSection
        id={initialLoad ? undefined : archiveSetting.id}
        title={archiveSetting.title}
        headerAction={searchField}
      >
        {rows.length === 0 ? (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {initialLoad ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {initialLoad
                  ? t("Loading archived threads")
                  : archive.error
                    ? t("Could not load archived threads")
                    : searching
                      ? t("No matching archived threads")
                      : t("No archived threads")}
              </span>
            }
            description={
              initialLoad
                ? t("Checking connected environments.")
                : (archive.error ??
                  (searching ? t("Try another search.") : t("Archived threads will appear here.")))
            }
          />
        ) : (
          rows.map((row) => (
            <ArchivedThreadRow
              key={`${row.thread.environmentId}:${row.thread.id}`}
              row={row}
              showProject={!scopedToProjects}
              showEnvironment={showEnvironment}
              onChanged={archive.refresh}
            />
          ))
        )}
        {rows.length > 0 && archive.error ? (
          <SettingsRow
            title={t("Could not load every archive")}
            description={archive.error}
            control={
              <Button type="button" variant="outline" size="sm" onClick={archive.refresh}>
                {t("Try again")}
              </Button>
            }
          />
        ) : null}
      </SettingsSection>
      {archive.hasMore ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={archive.isLoading}
            onClick={() => setLoaded({ viewKey, pages: pages + 1 })}
          >
            {archive.isLoading ? <Spinner size="sm" tone="muted" /> : null}
            {t("Load more")}
          </Button>
        </div>
      ) : null}
    </SettingsPageContainer>
  );
}
