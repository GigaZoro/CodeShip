export function getFileViewedRange<T extends { readonly fileKey: string }>(
  files: ReadonlyArray<T>,
  fileKey: string,
  anchorFileKey: string | null,
): ReadonlyArray<T> {
  const index = files.findIndex((file) => file.fileKey === fileKey);
  if (index === -1) return [];
  const anchorIndex = files.findIndex((file) => file.fileKey === anchorFileKey);
  if (anchorIndex === -1) return files.slice(index, index + 1);
  return files.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
}

/** Path to the file's content version when it was marked viewed. */
export type DiffFileViewedMarks = ReadonlyMap<string, number>;

/**
 * A file marked viewed whose content changed since reads as "changed", not viewed. A null
 * `version` is a file whose content has not loaded yet, which keeps its mark.
 */
export function diffFileViewedStatus(
  marks: DiffFileViewedMarks | undefined,
  path: string,
  version: number | null,
): "viewed" | "changed" | null {
  const marked = marks?.get(path);
  if (marked === undefined) return null;
  return version === null || version === marked ? "viewed" : "changed";
}

export function setDiffFilesViewed(
  marks: DiffFileViewedMarks,
  files: ReadonlyArray<{ readonly path: string; readonly version: number }>,
  viewed: boolean,
): DiffFileViewedMarks {
  const next = new Map(marks);
  for (const { path, version } of files) {
    if (viewed) next.set(path, version);
    else next.delete(path);
  }
  return next;
}
