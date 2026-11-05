import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  createSkillInventoriesRefreshAtomFamily,
  resolveSkillInventoryInstanceIds,
} from "@t3tools/client-runtime/providerSkills";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";

const providerWorkspaceSnapshotRefresh = createSkillInventoriesRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});

const idleRefreshAtom = Atom.make(false).pipe(
  Atom.withLabel("provider-workspace-snapshot-refresh:idle"),
);

/**
 * Keeps the available providers' workspace snapshots fresh for the composer's
 * cwd while mounted. Returns a check to run when the user types, and whether
 * the cwd's skills are still being scanned.
 */
export function useProviderWorkspaceSnapshotRefresh(input: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string | null;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly providers: readonly ServerProvider[];
  readonly availability: ServerSettings["skillAvailability"];
}): { readonly refresh: () => void; readonly scanning: boolean } {
  const { environmentId, gitCwd } = input;
  const instanceIds = resolveSkillInventoryInstanceIds(input);
  const atom =
    gitCwd && instanceIds.length > 0
      ? providerWorkspaceSnapshotRefresh({ environmentId, instanceIds, cwd: gitCwd })
      : idleRefreshAtom;
  return {
    refresh: useAtomRefresh(atom),
    scanning: useAtomValue(atom),
  };
}
