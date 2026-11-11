import { OrchestratorMcpSharedSettingsResult, type PeerLink } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import * as SharedSettings from "./SharedSettings.ts";

const PULL_INTERVAL = Duration.minutes(5);

/**
 * Takes shared settings from linked machines in the background, so a machine that was off when a
 * change was saved catches up with no app open. A change passes from machine to machine, so machines
 * that are not linked to each other still end up with the same value.
 */
export class SharedSettingsPull extends Context.Service<
  SharedSettingsPull,
  {
    readonly pullOnce: Effect.Effect<void>;
    /** Pulls now, then every few minutes, for as long as the server runs. */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/sharedSettings/SharedSettingsPull") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  const settings = yield* Settings.ServerSettingsService;
  const shared = yield* SharedSettings.SharedSettings;

  const pullFrom = Effect.fn("SharedSettingsPull.pullFrom")(function* (link: PeerLink) {
    const answer = yield* client
      .call({
        environmentId: link.environmentId,
        tool: "t3_shared_settings",
        arguments: {},
        limits: PeerMcpClient.READ_ONLY_PEER_LIMITS,
        success: OrchestratorMcpSharedSettingsResult,
      })
      .pipe(Effect.timeoutOption(PeerMcpClient.PEER_READ_TIMEOUT));
    if (Option.isNone(answer)) {
      return yield* Effect.logWarning("A linked machine did not answer a shared settings pull", {
        peer: link.environmentId,
      });
    }
    yield* shared.applyPulled(link.environmentId, answer.value.versions);
  });

  const pullOnce = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    if (!(yield* settings.getSettings).followSharedSettings) return;
    yield* shared.retryWaiting;
    const stored = yield* links.listStored;
    const now = yield* DateTime.now;
    yield* Effect.forEach(
      stored.filter((link) => DateTime.isGreaterThan(link.expiresAt, now)),
      (link) =>
        pullFrom(link).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not pull shared settings from a linked machine", {
              peer: link.environmentId,
              cause,
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not pull shared settings", { cause })),
    Effect.withSpan("SharedSettingsPull.pullOnce"),
  );

  const start = forkParked(
    pullOnce.pipe(Effect.andThen(Effect.sleep(PULL_INTERVAL)), Effect.forever),
  ).pipe(Effect.asVoid);

  return SharedSettingsPull.of({ pullOnce, start });
});

/** @public */
export const layer = Layer.effect(SharedSettingsPull, make);

/** Starts the background pull with the server. */
export const layerWorker = Layer.effectDiscard(
  SharedSettingsPull.pipe(Effect.flatMap((pull) => pull.start)),
).pipe(Layer.provide(layer));
