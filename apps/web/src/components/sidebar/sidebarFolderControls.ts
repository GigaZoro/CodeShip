import { create } from "zustand";

/** The sidebar's open and close for every folder, offered to the command palette. */
export interface SidebarFolderControls {
  readonly setAllExpanded: (expanded: boolean) => void;
}

const useSidebarFolderControlsStore = create<{ readonly controls: SidebarFolderControls | null }>(
  () => ({ controls: null }),
);

/** Null while the sidebar shows no folders. */
export function useSidebarFolderControls(): SidebarFolderControls | null {
  return useSidebarFolderControlsStore((state) => state.controls);
}

export function publishSidebarFolderControls(controls: SidebarFolderControls): () => void {
  useSidebarFolderControlsStore.setState({ controls });
  return () => {
    if (useSidebarFolderControlsStore.getState().controls === controls) {
      useSidebarFolderControlsStore.setState({ controls: null });
    }
  };
}
