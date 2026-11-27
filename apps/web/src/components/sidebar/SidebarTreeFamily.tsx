import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentShell } from "../../state/shell";
import { serverEnvironment } from "../../state/server";
import { threadFamilies } from "../../state/threads";
import type { SidebarOmittedChild } from "../Sidebar.logic";

const omittedByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const { snapshot } = get(environmentShell.stateValueAtom(environmentId));
    return Option.getOrNull(snapshot)?.omittedSidebarChildren;
  }),
);

const omittedChildren = Atom.make((get) => {
  const children = new Map<string, SidebarOmittedChild[]>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const omitted = get(omittedByEnvironment(environmentId));
    if (omitted === undefined) continue;
    const hidesTags = get(serverEnvironment.hiddenThreadTagsAtom(environmentId)) !== null;
    for (const [id, parent] of Object.entries(omitted)) {
      const delegated = typeof parent !== "string";
      const key = scopedThreadKey(
        delegated ? parent.delegatedFrom : scopeThreadRef(environmentId, parent),
      );
      const hint = {
        child: scopeThreadRef(environmentId, ThreadId.make(id)),
        delegated,
        hidesTags,
      };
      const siblings = children.get(key);
      if (siblings) siblings.push(hint);
      else children.set(key, [hint]);
    }
  }
  return children;
});

export function useSidebarOmittedChildren() {
  return useAtomValue(omittedChildren);
}

export function SidebarTreeFamily(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retain the family's missing shell rows while the sidebar displays or filters its children
  useEffect(
    () => threadFamilies.mount(appAtomRegistry, environmentId, threadId),
    [environmentId, threadId],
  );
  return null;
}
