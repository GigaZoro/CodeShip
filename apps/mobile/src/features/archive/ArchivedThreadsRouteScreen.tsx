import type { EnvironmentId } from "@t3tools/contracts";
import { makeArchivedThreadsViewKey } from "@t3tools/client-runtime/state/threads";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";

import { useDebouncedValue } from "../../state/queries";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useArchivedThreadListActions } from "../home/useThreadListActions";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import {
  ArchivedThreadsScreen,
  type ArchivedThreadsHeaderEnvironment,
} from "./ArchivedThreadsScreen";
import { buildArchivedThreadGroups, type ArchivedThreadSortOrder } from "./archivedThreadList";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "./useArchivedThreadSnapshots";

const SEARCH_DEBOUNCE_MS = 250;

export function ArchivedThreadsRouteScreen() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [searchQuery, setSearchQuery] = useState("");
  const searchedQuery = useDebouncedValue(searchQuery.trim(), SEARCH_DEBOUNCE_MS);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [sortOrder, setSortOrder] = useState<ArchivedThreadSortOrder>("newest");
  const environments = useMemo<ReadonlyArray<ArchivedThreadsHeaderEnvironment>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
        Order.mapInput(Order.String, (environment: ArchivedThreadsHeaderEnvironment) =>
          environment.label.toLocaleLowerCase(),
        ),
      ),
    [savedConnectionsById],
  );
  const environmentIds = useMemo(
    () =>
      selectedEnvironmentId === null
        ? environments.map((environment) => environment.environmentId)
        : [selectedEnvironmentId],
    [environments, selectedEnvironmentId],
  );
  const view = { environmentIds, query: searchedQuery, order: sortOrder };
  // More pages stay loaded only for the search, machine and order they were loaded for.
  const viewKey = makeArchivedThreadsViewKey(view);
  const [loaded, setLoaded] = useState({ viewKey, pages: 1 });
  const pages = loaded.viewKey === viewKey ? loaded.pages : 1;
  const { error, hasMore, isLoading, refresh, snapshots } = useArchivedThreadSnapshots({
    ...view,
    pages,
  });
  const groups = useMemo(
    () => buildArchivedThreadGroups({ snapshots, sortOrder }),
    [snapshots, sortOrder],
  );
  const refreshChangedEnvironment = (thread: { readonly environmentId: EnvironmentId }) => {
    refreshArchivedThreadsForEnvironment(thread.environmentId);
  };
  const { unarchiveThread, confirmDeleteThread } =
    useArchivedThreadListActions(refreshChangedEnvironment);
  const openThread = useOpenLinkedThread();

  useFocusEffect(
    useCallback(() => {
      for (const environmentId of environmentIds) {
        refreshArchivedThreadsForEnvironment(environmentId);
      }
    }, [environmentIds]),
  );

  return (
    <ArchivedThreadsScreen
      environments={environments}
      error={error}
      groups={groups}
      isLoading={isLoading}
      loadingMore={isLoading && pages > 1}
      onDeleteThread={confirmDeleteThread}
      onEndReached={
        hasMore && !isLoading ? () => setLoaded({ viewKey, pages: pages + 1 }) : undefined
      }
      onEnvironmentChange={setSelectedEnvironmentId}
      onOpenThread={(thread) =>
        openThread({ environmentId: String(thread.environmentId), threadId: String(thread.id) })
      }
      onRefresh={refresh}
      onSearchQueryChange={setSearchQuery}
      onSortOrderChange={setSortOrder}
      onUnarchiveThread={unarchiveThread}
      searchQuery={searchQuery}
      selectedEnvironmentId={selectedEnvironmentId}
      sortOrder={sortOrder}
    />
  );
}
