/**
 * "Install updates automatically when idle" while no window is open: the open window runs it
 * itself (DesktopAutoUpdateCoordinator), but on macOS the app outlives its last window.
 */
import {
  DESKTOP_AUTO_INSTALL_READINESS_PATH,
  DesktopAutoInstallReadiness,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import {
  type AutoDesktopUpdateAttempts,
  getDesktopUpdateDownloadedVersion,
  resolveAutoDesktopUpdateStep,
  resolveDesktopUpdateButtonAction,
} from "@t3tools/shared/desktopAutoUpdate";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-auto-install");

/** Releases land every few minutes; a restart waits for idle, so a slow look costs little. */
const POLL_INTERVAL = Duration.seconds(30);
const READINESS_TIMEOUT = Duration.seconds(10);

export interface AutoInstallPorts {
  readonly hasWindow: Effect.Effect<boolean>;
  readonly getState: Effect.Effect<DesktopUpdateState>;
  /** `None` when the server cannot be asked; that counts as busy. */
  readonly readReadiness: Effect.Effect<Option.Option<DesktopAutoInstallReadiness>>;
  readonly download: Effect.Effect<void>;
  readonly install: (version: string) => Effect.Effect<void>;
}

/**
 * One look at the updater and the server. A version this app already tried to download or install
 * is never retried here, so a failing build cannot loop; the update button still offers it.
 */
export const autoInstallTick = Effect.fn("DesktopAutoInstall.tick")(function* (
  ports: AutoInstallPorts,
  attempts: Ref.Ref<AutoDesktopUpdateAttempts>,
) {
  if (yield* ports.hasWindow) return;
  const state = yield* ports.getState;
  if (resolveDesktopUpdateButtonAction(state) === "none") return;
  const readiness = yield* ports.readReadiness;
  if (Option.isNone(readiness)) return;
  const step = resolveAutoDesktopUpdateStep({
    enabled: readiness.value.enabled,
    state,
    waitingToInstall: false,
    attempts: yield* Ref.get(attempts),
  });
  const version = getDesktopUpdateDownloadedVersion(state);
  if (version === null) return;
  if (step === "download") {
    yield* Ref.update(attempts, (current) => ({ ...current, download: version }));
    yield* logInfo("downloading update with every window closed", { version });
    return yield* ports.download;
  }
  if (step !== "install" || !readiness.value.idle) return;
  // A chat may have started since the first look; a restart would cut it.
  const fresh = yield* ports.readReadiness;
  if (Option.isNone(fresh) || !fresh.value.enabled || !fresh.value.idle) return;
  yield* Ref.update(attempts, (current) => ({ ...current, install: version }));
  yield* logInfo("installing update with every window closed", { version });
  yield* ports.install(version);
});

export const listen: Effect.Effect<
  void,
  never,
  | DesktopUpdates.DesktopUpdates
  | DesktopBackendPool.DesktopBackendPool
  | DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth
  | DesktopEnvironment.DesktopEnvironment
  | ElectronWindow.ElectronWindow
  | HttpClient.HttpClient
  | Scope.Scope
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  // Windows and Linux quit when the last window closes, so no window means no app there.
  if (environment.platform !== "darwin") return;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const backends = yield* DesktopBackendPool.DesktopBackendPool;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const httpClient = yield* HttpClient.HttpClient;
  const attempts = yield* Ref.make<AutoDesktopUpdateAttempts>({ download: null, install: null });

  const readReadiness = Effect.gen(function* () {
    const primary = yield* backends.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) return Option.none<DesktopAutoInstallReadiness>();
    const token = yield* localAuth.getBearerToken;
    const url = new URL(DESKTOP_AUTO_INSTALL_READINESS_PATH, config.value.httpBaseUrl);
    const readiness = yield* httpClient
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DesktopAutoInstallReadiness)),
        Effect.timeout(READINESS_TIMEOUT),
      );
    return Option.some(readiness);
  }).pipe(
    Effect.catch((cause) =>
      logWarning("could not read automatic install readiness", { cause: String(cause) }).pipe(
        Effect.as(Option.none<DesktopAutoInstallReadiness>()),
      ),
    ),
  );

  const ports: AutoInstallPorts = {
    hasWindow: electronWindow.main.pipe(Effect.map(Option.isSome)),
    getState: updates.getState,
    readReadiness,
    download: updates.download.pipe(Effect.asVoid),
    install: (expectedVersion) =>
      updates.install({ expectedVersion, resumeThreads: true }).pipe(Effect.asVoid),
  };

  yield* autoInstallTick(ports, attempts).pipe(
    Effect.catchCause((cause) =>
      logWarning("automatic install check failed", { cause: String(cause) }),
    ),
    Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
    Effect.forkScoped,
  );
});
