import { type EnvironmentId, T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

import { createContext, type ReactNode, useContext } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { getProjectFileQueryAtom, optimisticFileAtom } from "../files/projectFilesQueryState";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import {
  applyPendingScopedWrites,
  pendingScopedWritesAtom,
  resolveScopedSettingsTargets,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";
import type { SettingScopeAxes } from "./settingsSearch";

type ProjectFileMember = readonly [
  environmentId: EnvironmentId,
  workspaceRoot: string,
  physicalProjectKey: string,
];

const memberProjectFilesAtom = Atom.family((membersKey: string) => {
  const members = JSON.parse(membersKey) as ReadonlyArray<ProjectFileMember>;
  return Atom.make((get) => {
    const files = new Map<string, T3ProjectFile | null>();
    for (const [environmentId, workspaceRoot, physicalProjectKey] of members) {
      const result = get(
        getProjectFileQueryAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME),
      );
      if (result.waiting) continue;
      const data =
        get(optimisticFileAtom(environmentId, workspaceRoot, T3_PROJECT_FILE_NAME))?.data ??
        AsyncResult.getOrElse(result, () => null);
      files.set(
        physicalProjectKey,
        data === null || data.exists === false || data.truncated
          ? null
          : parseT3ProjectFile(data.contents),
      );
    }
    return files;
  }).pipe(Atom.withLabel(`web-settings-member-project-files:${membersKey}`));
});

function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    memberProjectFilesAtom(
      JSON.stringify(
        members.map((member): ProjectFileMember => [
          member.environmentId,
          member.workspaceRoot,
          member.physicalProjectKey,
        ]),
      ),
    ),
  );
}

type SettingsProjectGroups = ReturnType<typeof useSettingsProjectGroups>;

function useResolvedSettingsScope(
  rawSearch: SettingsScopeSearch,
  singleEnvironment: boolean,
  groups: SettingsProjectGroups,
) {
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const search = singleEnvironment
    ? selectSingleEnvironmentScope(
        rawSearch,
        resolveSettingsScope(rawSearch, groups, availableEnvironments),
        availableEnvironments,
        primaryEnvironmentId,
      )
    : rawSearch;
  const scope = resolveSettingsScope(search, groups, availableEnvironments);
  const projectFiles = useMemberProjectFiles(scope);
  const pendingWrites = useAtomValue(pendingScopedWritesAtom);
  const selected = selectScopedSettingsEnvironments(
    scope,
    availableEnvironments,
    primaryEnvironmentId,
  );
  const targets = resolveScopedSettingsTargets(
    scope,
    applyPendingScopedWrites(selected.connectedEnvironments, pendingWrites),
    projectFiles,
  );
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return { scope, groups, search, ...selected, targets, target };
}

/** One setting's own scope, chosen with the pill on its row. */
export interface SettingScopeUnit {
  /** The search item id of the row or section that shows the pill. */
  readonly anchorId: string;
  readonly title: string;
  readonly axes: SettingScopeAxes;
}

/** Which scope a page lists or shows things for, picked in the line at the top of the page. */
export type SettingsViewFilter = "machine" | "project-and-machine";

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      deviceOnly: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
      unit: SettingScopeUnit | null;
      viewFilter: SettingsViewFilter | null;
    })
  | null
>(null);

interface SettingsScopeProviderProps {
  singleEnvironment?: boolean;
  /** The page hides the scope picker, so its client settings save for this device. */
  deviceOnly?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  unit?: SettingScopeUnit | null;
  viewFilter?: SettingsViewFilter | null;
  children: ReactNode;
}

export function SettingsScopeProvider(props: SettingsScopeProviderProps) {
  const parent = useContext(SettingsScopeContext);
  // Each row's scope nests in its page's; the project list is the same, so build it once per page.
  return parent ? (
    <ResolvedSettingsScopeProvider {...props} groups={parent.groups} />
  ) : (
    <RootSettingsScopeProvider {...props} />
  );
}

function RootSettingsScopeProvider(props: SettingsScopeProviderProps) {
  return <ResolvedSettingsScopeProvider {...props} groups={useSettingsProjectGroups()} />;
}

function ResolvedSettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
  deviceOnly = false,
  unit = null,
  viewFilter = null,
  groups,
}: SettingsScopeProviderProps & { groups: SettingsProjectGroups }) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment, groups);
  const value = {
    ...resolved,
    singleEnvironment,
    deviceOnly,
    selectScope: onChange,
    unit,
    viewFilter,
  };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

const EVERY_MACHINE_SCOPE: SettingsScopeSearch = {};
const ignoreScopeChange = () => {};

/** For rows on pages without a scope picker that read and write every machine. */
export function EveryMachineSettingsScope({ children }: { children: ReactNode }) {
  return (
    <SettingsScopeProvider search={EVERY_MACHINE_SCOPE} onChange={ignoreScopeChange}>
      {children}
    </SettingsScopeProvider>
  );
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
