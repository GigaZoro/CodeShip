// A rail-only sidebar is narrower than the window controls on macOS, so the page clears the rest.
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)] md:[[data-sidebar-rail-only][data-sidebar-state=expanded]_&]:pl-[max(var(--workspace-gutter-start),calc(var(--workspace-titlebar-content-left)_-_var(--sidebar-width)))]";
