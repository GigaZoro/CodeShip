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
import { threadFamilies } from "../../state/threads";

const omittedByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const { snapshot } = get(environmentShell.stateValueAtom(environmentId));
    return Option.getOrNull(snapshot)?.omittedSidebarChildren;
  }),
);

const omittedChildren = Atom.make((get) => {
  const children = new Map<string, ThreadId[]>();
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const omitted = get(omittedByEnvironment(environmentId));
    if (omitted === undefined) continue;
    for (const [id, parentId] of Object.entries(omitted)) {
      const key = scopedThreadKey(scopeThreadRef(environmentId, parentId));
      const siblings = children.get(key);
      if (siblings) siblings.push(ThreadId.make(id));
      else children.set(key, [ThreadId.make(id)]);
    }
  }
  return children;
});

export function useSidebarOmittedChildren() {
  return useAtomValue(omittedChildren);
}

export function SidebarTreeFamily(props: {
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
}) {
  const { environmentId, rootThreadId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- retain the family's missing shell rows while the sidebar displays or filters its children
  useEffect(
    () => threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId),
    [environmentId, rootThreadId],
  );
  return null;
}
