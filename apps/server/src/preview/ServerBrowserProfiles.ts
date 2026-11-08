// @effect-diagnostics nodeBuiltinImport:off - ServerBrowserContexts names profile folders outside the Effect runtime.
import * as NodePath from "node:path";

import {
  BrowserProfile,
  BrowserProfileId,
  BrowserRecordingFrameRate,
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  findBrowserProfile,
  isBuiltInBrowserProfileId,
  resolveBrowserProfiles,
  type PreviewReportProfilesInput,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

/** The folder that holds a persistent profile's cookies and storage. */
export const profileDirectory = (profilesDir: string, profileId: string) => {
  const encoded = encodeURIComponent(profileId);
  return NodePath.join(
    profilesDir,
    profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
  );
};

const SavedReport = Schema.Struct({
  profiles: Schema.Array(BrowserProfile),
  defaultProfileId: BrowserProfileId,
  recordingFrameRate: BrowserRecordingFrameRate,
});
const SavedReportJson = Schema.fromJsonString(SavedReport);
const decodeSavedReport = Schema.decodeUnknownEffect(SavedReportJson);
const encodeSavedReport = Schema.encodeSync(SavedReportJson);
const isBrowserProfileId = Schema.is(BrowserProfileId);

export type ProfileReporter = (input: PreviewReportProfilesInput) => Effect.Effect<void>;

interface Catalog {
  readonly profiles: ReadonlyArray<BrowserProfile>;
  readonly defaultProfileId: string;
}

const describeProfiles = (profiles: ReadonlyArray<BrowserProfile>) =>
  profiles.map((profile) => `${profile.name} (id ${profile.id})`).join(", ");

/**
 * The browser profiles connected apps report, saved under the state dir so agents keep the
 * user's profiles after a restart, before any app connects again.
 */
export const make = Effect.fn("ServerBrowserProfiles.make")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profilesDir = NodePath.join(stateDir, "server-browser", "profiles");
  const savedPath = NodePath.join(stateDir, "server-browser", "reported-profiles.json");
  const lock = yield* Semaphore.make(1);

  const saved = yield* fs.readFileString(savedPath).pipe(
    Effect.flatMap(decodeSavedReport),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    Effect.catch((cause) =>
      Effect.logError("server browser ignored its unreadable saved profiles", {
        path: savedPath,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  let catalog: Catalog | null = null;
  if (saved !== null) {
    const profiles = resolveBrowserProfiles(saved.profiles);
    catalog = {
      profiles,
      defaultProfileId:
        findBrowserProfile(profiles, saved.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
    };
  }
  // Agent recordings encode on the server, so they need the rate the user chose in an app.
  let recordingFrameRate = saved?.recordingFrameRate ?? DEFAULT_BROWSER_RECORDING_FRAME_RATE;
  let savedContents: string | undefined;

  const hasData = (profileId: string) =>
    fs.exists(profileDirectory(profilesDir, profileId)).pipe(
      Effect.catch((cause) =>
        Effect.logError("server browser could not check a profile's folder", {
          profileId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  const save = Effect.suspend(() => {
    if (catalog === null) return Effect.void;
    const contents = encodeSavedReport({
      profiles: catalog.profiles.filter((profile) => !isBuiltInBrowserProfileId(profile.id)),
      defaultProfileId: catalog.defaultProfileId,
      recordingFrameRate,
    });
    if (contents === savedContents) return Effect.void;
    return writeFileStringAtomically({ filePath: savedPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.andThen(
        Effect.sync(() => {
          savedContents = contents;
        }),
      ),
      Effect.catch((cause) =>
        Effect.logError("server browser could not save the reported profiles", {
          path: savedPath,
          cause,
        }),
      ),
    );
  });

  const reports = new Map<number, PreviewReportProfilesInput>();
  let nextClient = 0;

  // Each app reports only the profiles in its own settings. A profile that no connected app
  // reports stays while its folder exists, since that holds its sign-in; removing a profile in
  // an app's settings deletes that folder on every server first.
  const rebuild = Effect.gen(function* () {
    const reported = new Map<string, BrowserProfile>();
    let latest: PreviewReportProfilesInput | undefined;
    for (const report of reports.values()) {
      for (const profile of report.profiles) reported.set(profile.id, profile);
      latest = report;
    }
    // The last catalog stays usable after every app disconnects.
    if (latest === undefined) return;
    const kept = yield* Effect.filter(
      (catalog?.profiles ?? []).filter(
        (profile) => !reported.has(profile.id) && !isBuiltInBrowserProfileId(profile.id),
      ),
      (profile) => hasData(profile.id),
    );
    const profiles = resolveBrowserProfiles([...reported.values(), ...kept]);
    catalog = {
      profiles,
      defaultProfileId:
        findBrowserProfile(profiles, latest.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
    };
    yield* save;
  });

  const reporter: Effect.Effect<ProfileReporter, never, Scope.Scope> = Effect.acquireRelease(
    Effect.sync(() => nextClient++),
    (client) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          reports.delete(client);
          return rebuild;
        }),
      ),
  ).pipe(
    Effect.map(
      (client): ProfileReporter =>
        (input) =>
          lock.withPermits(1)(
            Effect.suspend(() => {
              if (input.recordingFrameRate !== undefined)
                recordingFrameRate = input.recordingFrameRate;
              reports.delete(client);
              reports.set(client, input);
              return rebuild;
            }),
          ),
    ),
  );

  const status = () => {
    const profiles = catalog?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    return {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        ...(profile.kind === "incognito" ? { incognito: true } : {}),
      })),
      ...(catalog ? { defaultProfileId: catalog.defaultProfileId } : {}),
    };
  };

  /** Resolves a profile id or name an agent asked for; undefined asks for the default. */
  const resolveOpen = Effect.fn("ServerBrowserProfiles.resolveOpen")(function* (
    requested: string | undefined,
  ) {
    if (requested === undefined) return catalog?.defaultProfileId;
    const profiles = catalog?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    const byId = findBrowserProfile(profiles, requested);
    if (byId) return byId.id;
    const wanted = requested.toLowerCase();
    const named = profiles.filter((profile) => profile.name.toLowerCase() === wanted);
    // Ids are random per app, so two apps can each have a profile with this name. Usually
    // only one of them was ever used here, and its folder holds the sign-in.
    const candidates =
      named.length > 1 ? yield* Effect.filter(named, (profile) => hasData(profile.id)) : named;
    if (candidates.length === 1) return candidates[0]!.id;
    if (named.length > 1) {
      return yield* Effect.fail(
        new ServerBrowserOperationError(
          "PreviewAutomationAmbiguousProfileError",
          `${named.length} browser profiles are named "${requested}": ${describeProfiles(named)}. Pass the id of the one to use.`,
        ),
      );
    }
    // A profile used here before stays usable by id, even when no app has reported it.
    if (isBrowserProfileId(requested) && (yield* hasData(requested))) return requested;
    return yield* Effect.fail(
      new ServerBrowserOperationError(
        "PreviewAutomationUnknownProfileError",
        `No browser profile is named "${requested}". Use one of: ${describeProfiles(profiles)}.`,
      ),
    );
  });

  return {
    profilesDir,
    reporter,
    status,
    resolveOpen,
    recordingFrameRate: () => recordingFrameRate,
  };
});
