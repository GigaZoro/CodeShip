/** The account and server a detected sign-in names; Capabilities narrows to it until "Show all". */
export type CapabilitiesFocus = {
  readonly environmentId?: string;
  readonly instanceId?: string;
  readonly server?: string;
};

export function isCapabilitiesFocused(focus: CapabilitiesFocus | undefined): boolean {
  return (
    focus !== undefined &&
    (focus.environmentId !== undefined ||
      focus.instanceId !== undefined ||
      focus.server !== undefined)
  );
}

/**
 * Whether an environment, or one of its accounts, belongs to the focus. The environment filter
 * is bypassed: the sign-in is wanted wherever it was detected.
 */
export function matchesCapabilitiesFocus(
  focus: CapabilitiesFocus | undefined,
  account: { readonly environmentId: string; readonly instanceId?: string },
): boolean {
  return (
    (focus?.environmentId === undefined || focus.environmentId === account.environmentId) &&
    (focus?.instanceId === undefined ||
      account.instanceId === undefined ||
      focus.instanceId === account.instanceId)
  );
}

/** The focused server leads its account's list, so it is the first row on screen. */
export function focusedServerFirst<Server extends { readonly name: string }>(
  servers: readonly Server[],
  focus: CapabilitiesFocus | undefined,
): readonly Server[] {
  const focused = servers.filter((server) => server.name === focus?.server);
  return focused.length === 0
    ? servers
    : [...focused, ...servers.filter((server) => server.name !== focus?.server)];
}
