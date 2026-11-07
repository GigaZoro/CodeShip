import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, use, useState, type Dispatch, type ReactNode } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveSelectedNavigationTab } from "./navigation-tab-order";
import { effectiveHiddenNavigationTabs } from "./native-tab-support";
import {
  initialWorkspaceTabsState,
  resolveWorkspaceTabOrder,
  withLinkedWorkspaceTab,
  workspaceTabsReducer,
  type LinkedWorkspaceTab,
  type WorkspaceSearchTab,
  type WorkspaceTab,
  type WorkspaceTabsAction,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";

export const WorkspaceTabsContext = createContext<{
  readonly state: WorkspaceTabsState;
  readonly dispatch: Dispatch<WorkspaceTabsAction>;
  readonly isTabActive: (tab: WorkspaceTab) => boolean;
  readonly bottomClearance: number;
  readonly settingsOpen: boolean;
  readonly getScrollOffset: (tab: WorkspaceSearchTab) => number;
  readonly recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => void;
} | null>(null);

export function useWorkspaceTabs() {
  return use(WorkspaceTabsContext);
}

type MobilePreferencesResult = Atom.Type<typeof mobilePreferencesAtom>;

// App-wide rather than per provider, so a remounted tab bar does not reopen an old link's tab.
const linkedWorkspaceTabAtom = Atom.make<LinkedWorkspaceTab | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:linked-workspace-tab"),
);
const handledLinkedWorkspaceTabAtom = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:handled-linked-workspace-tab"),
);
let linkedWorkspaceTabCount = 0;

/** Opens a tab from outside the tab bar, such as a launcher shortcut or notification link. */
export function openWorkspaceTabFromLink(tab: WorkspaceTab): void {
  linkedWorkspaceTabCount += 1;
  appAtomRegistry.set(linkedWorkspaceTabAtom, { tab, id: linkedWorkspaceTabCount });
}

/** Moves the selection off a tab the user has hidden or that no longer exists. */
function resolveWorkspaceTabsSelection(
  state: WorkspaceTabsState,
  preferences: MobilePreferencesResult,
): WorkspaceTabsState {
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
  const order = resolveWorkspaceTabOrder(saved?.navigationTabOrder);
  const hidden = effectiveHiddenNavigationTabs(saved?.hiddenNavigationTabs);
  const selected = resolveSelectedNavigationTab(order, hidden, state.selectedTab);
  return selected && selected !== state.selectedTab
    ? workspaceTabsReducer(state, { type: "select", tab: selected })
    : state;
}

// One model per provider. Handlers on frozen screens keep stale closures, so
// they read the current selection from the registry at call time.
function createWorkspaceTabsModel() {
  const stored = Atom.make(initialWorkspaceTabsState());
  const scrollOffsets: Record<WorkspaceSearchTab, number> = {
    threads: 0,
    scheduledTasks: 0,
    pullRequests: 0,
    usage: 0,
    settings: 0,
  };
  return {
    stored,
    resolved: Atom.make((get) =>
      resolveWorkspaceTabsSelection(
        withLinkedWorkspaceTab(
          get(stored),
          get(linkedWorkspaceTabAtom),
          get(handledLinkedWorkspaceTabAtom),
        ),
        get(mobilePreferencesAtom),
      ),
    ),
    getScrollOffset: (tab: WorkspaceSearchTab) => scrollOffsets[tab],
    recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => {
      scrollOffsets[tab] = offset;
    },
  };
}

export function WorkspaceTabsProvider(props: {
  readonly children: ReactNode;
  readonly settingsOpen?: boolean;
}) {
  const registry = use(RegistryContext);
  const [model] = useState(createWorkspaceTabsModel);
  const state = useAtomValue(model.resolved);
  const context = {
    state,
    dispatch: (action: WorkspaceTabsAction) => {
      const current = registry.get(model.resolved);
      registry.set(handledLinkedWorkspaceTabAtom, registry.get(linkedWorkspaceTabAtom)?.id ?? 0);
      registry.set(model.stored, workspaceTabsReducer(current, action));
    },
    isTabActive: (tab: WorkspaceTab) => registry.get(model.resolved).selectedTab === tab,
    bottomClearance: 0,
    settingsOpen: props.settingsOpen ?? false,
    getScrollOffset: model.getScrollOffset,
    recordScrollOffset: model.recordScrollOffset,
  };
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
