import type {
  ThreadGitControlsProps,
  useThreadGitMenuDefinition as useIosThreadGitMenuDefinition,
  useThreadGitRightHeaderItems as useIosThreadGitRightHeaderItems,
} from "./ThreadGitControls";

const EMPTY_HEADER_ITEMS: ReturnType<typeof useIosThreadGitRightHeaderItems> = [];

// oxlint-disable-next-line t3code/no-hookless-use-function -- Android stub of a hook; the iOS file calls hooks.
export function useThreadGitRightHeaderItems(_props: ThreadGitControlsProps) {
  return EMPTY_HEADER_ITEMS;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- Android stub of a hook; the iOS file calls hooks.
export function useThreadGitCenterHeaderItems(_props: ThreadGitControlsProps) {
  return EMPTY_HEADER_ITEMS;
}

// oxlint-disable-next-line t3code/no-hookless-use-function -- Android stub of a hook; the iOS file calls hooks.
export function useThreadGitMenuDefinition(
  _props: Parameters<typeof useIosThreadGitMenuDefinition>[0],
): ReturnType<typeof useIosThreadGitMenuDefinition> {
  return null;
}
