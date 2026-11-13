import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as RunConditionCheck from "./RunConditionCheck.ts";
import * as PromptFileReader from "./PromptFileReader.ts";
import * as SharedTaskPeerCheck from "./SharedTaskPeerCheck.ts";

export const HERE_ENVIRONMENT_ID = EnvironmentId.make("environment-here");

export interface TestSharedProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  /** The repository the workspace resolves to; null for a folder without a git remote. */
  readonly canonicalKey: string | null;
}

/** Peers that have not run anything, so a one-machine task runs here. */
const layerNoPeersRan = Layer.mock(SharedTaskPeerCheck.SharedTaskPeerCheck)({
  linkedEnvironmentIds: Effect.succeed([]),
  linkStatus: Effect.succeed({ enabled: false, links: [] }),
  check: () =>
    Effect.succeed({
      ranOn: null,
      working: false,
      noWork: null,
      lastRunWorkingOn: null,
      unchecked: [],
    }),
  claim: () => Effect.succeed({ answered: [], unchecked: [] }),
});

/** A run condition that always finds work, so a task with one runs as it would without. */
const layerRunConditionFindsWork = Layer.mock(RunConditionCheck.RunConditionCheck)({
  run: () => Effect.succeed({ outcome: "run", failure: null, exitCode: 0, detail: null }),
});

/** A reader for tests that set no prompt file: any read is a bug in the test. */
const layerNoPromptFiles = Layer.mock(PromptFileReader.PromptFileReader)({
  read: ({ path }) => Effect.die(`This test reads no prompt file, but read ${path}.`),
});

/**
 * This machine's id, its projects and its prompt files, for services that only need to identify
 * a repository or read from it.
 */
export const layerSharedTaskIdentities = (
  projects: ReadonlyArray<TestSharedProject> = [],
  peerCheck: Layer.Layer<SharedTaskPeerCheck.SharedTaskPeerCheck> = layerNoPeersRan,
  runConditionCheck: Layer.Layer<RunConditionCheck.RunConditionCheck> = layerRunConditionFindsWork,
  promptFiles: Layer.Layer<PromptFileReader.PromptFileReader> = layerNoPromptFiles,
) =>
  Layer.mergeAll(
    peerCheck,
    runConditionCheck,
    promptFiles,
    Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
      getEnvironmentId: Effect.succeed(HERE_ENVIRONMENT_ID),
    }),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: (cwd) => {
        const key = projects.find((project) => project.workspaceRoot === cwd)?.canonicalKey;
        return Effect.succeed(
          key === undefined || key === null ? null : ({ canonicalKey: key } as never),
        );
      },
    }),
  );

export const layerSharedTaskDependencies = (
  projects: ReadonlyArray<TestSharedProject> = [],
  peerCheck?: Layer.Layer<SharedTaskPeerCheck.SharedTaskPeerCheck>,
  runConditionCheck?: Layer.Layer<RunConditionCheck.RunConditionCheck>,
  promptFiles?: Layer.Layer<PromptFileReader.PromptFileReader>,
) =>
  Layer.mergeAll(
    layerSharedTaskIdentities(projects, peerCheck, runConditionCheck, promptFiles),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          Option.fromNullishOr(
            projects.find((project) => ProjectId.make(project.id) === projectId) as never,
          ),
        ),
      listPage: () =>
        Effect.succeed({
          projects: projects.map((project) => ({ ...project, id: ProjectId.make(project.id) })),
          nextCursor: null,
        } as never),
    }),
  );
