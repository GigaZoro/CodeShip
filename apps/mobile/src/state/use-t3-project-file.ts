import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectReadFileResult,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";

import { useEnvironmentPresentation } from "./presentation";
import { projectEnvironment } from "./projects";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";

export interface T3ProjectFileState {
  /** `unavailable` when this connection cannot read the checkout's files. */
  readonly status: "loading" | "missing" | "invalid" | "valid" | "unavailable";
  readonly file: T3ProjectFile | null;
}

/** The checkout's t3.json, read through the shared per-project file atom. */
export function useT3ProjectFile(
  project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string } | null,
): T3ProjectFileState {
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  const session = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const environment = useEnvironmentPresentation(project?.environmentId ?? null);
  const access = resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
  const query = useEnvironmentQuery(
    access.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: T3_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  if (!hasWorkspace) return { status: "missing", file: null };
  const data = query.data as ProjectReadFileResult | null;
  const contents = data === null || data.exists === false || data.truncated ? null : data.contents;
  const file = contents === null ? null : parseT3ProjectFile(contents);
  if (access.isPending || query.isPending) return { status: "loading", file };
  if (!access.canReadFiles) return { status: "unavailable", file: null };
  if (contents === null) return { status: "missing", file: null };
  return file === null ? { status: "invalid", file } : { status: "valid", file };
}
