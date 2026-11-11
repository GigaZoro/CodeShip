import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type OrchestratorMcpSharedSettingsResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Settings from "../serverSettings.ts";
import * as SharedSettings from "./SharedSettings.ts";
import * as SharedSettingsPull from "./SharedSettingsPull.ts";

const GOOD = EnvironmentId.make("environment-good");
const DOWN = EnvironmentId.make("environment-down");
const OLD = EnvironmentId.make("environment-expired");
const OLDER_BUILD = EnvironmentId.make("environment-older-build");

const link = (environmentId: EnvironmentId, expiresAt: string) =>
  ({ environmentId, expiresAt: DateTime.makeUnsafe(expiresAt) }) as never;

const answer: OrchestratorMcpSharedSettingsResult = {
  versions: [
    {
      key: "finalReviewByDefault",
      value: true,
      updatedAt: "2026-09-10T00:00:00.000Z",
      origin: GOOD,
    },
  ],
};

const pull = (input: {
  readonly linksEnabled?: boolean;
  readonly follows?: boolean;
  readonly calls: Ref.Ref<ReadonlyArray<{ environmentId: string; tool: string }>>;
  readonly applied: Ref.Ref<ReadonlyArray<string>>;
  readonly retries: Ref.Ref<number>;
  readonly logger: Logger.Logger<unknown, void>;
}) =>
  Effect.gen(function* () {
    const service = yield* SharedSettingsPull.SharedSettingsPull;
    yield* service.pullOnce;
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([input.logger], { mergeWithExisting: false }),
        SharedSettingsPull.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Settings.layerTest({ followSharedSettings: input.follows ?? true }),
              Layer.mock(PeerLinks.PeerLinks)({
                enabled: Effect.succeed(input.linksEnabled ?? true),
                listStored: Effect.succeed([
                  link(GOOD, "2027-01-01T00:00:00.000Z"),
                  link(DOWN, "2027-01-01T00:00:00.000Z"),
                  link(OLDER_BUILD, "2027-01-01T00:00:00.000Z"),
                  link(OLD, "2020-01-01T00:00:00.000Z"),
                ]),
              }),
              Layer.mock(PeerMcpClient.PeerMcpClient)({
                callIfAvailable: ((request: { environmentId: string; tool: string }) =>
                  Ref.update(input.calls, (calls) => [...calls, request]).pipe(
                    Effect.andThen(() =>
                      request.environmentId === GOOD
                        ? Effect.succeedSome(answer)
                        : request.environmentId === OLDER_BUILD
                          ? Effect.succeedNone
                          : Effect.fail(
                              new OrchestratorMcpFailure({
                                code: "orchestration_error",
                                message: "It stopped answering.",
                              }),
                            ),
                    ),
                  )) as never,
              }),
              Layer.mock(SharedSettings.SharedSettings)({
                applyPulled: (peer, versions) =>
                  Ref.update(input.applied, (applied) => [
                    ...applied,
                    `${peer}:${versions.map((version) => version.key).join(",")}`,
                  ]),
                retryWaiting: Ref.update(input.retries, (count) => count + 1),
              }),
            ),
          ),
        ),
      ),
    ),
  );

const fresh = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse("2026-09-09T12:00:00.000Z"));
  const warnings: Array<string> = [];
  return {
    calls: yield* Ref.make<ReadonlyArray<{ environmentId: string; tool: string }>>([]),
    applied: yield* Ref.make<ReadonlyArray<string>>([]),
    retries: yield* Ref.make(0),
    warnings,
    logger: Logger.make(({ logLevel, message }) => {
      // The text comes first, then the annotations.
      if (logLevel === "Warn") warnings.push(String(Array.isArray(message) ? message[0] : message));
    }),
  };
});

it.effect("asks each live link for its shared settings and applies what it answers", () =>
  Effect.gen(function* () {
    const state = yield* fresh;
    yield* pull(state);
    const made = yield* Ref.get(state.calls);
    // The expired link is skipped; the failing peer neither blocks nor hides the good one.
    expect(made.map((call) => call.environmentId).toSorted()).toEqual([DOWN, GOOD, OLDER_BUILD]);
    expect(made.every((call) => call.tool === "t3_shared_settings")).toBe(true);
    expect(yield* Ref.get(state.applied)).toEqual([`${GOOD}:finalReviewByDefault`]);
    expect(yield* Ref.get(state.retries)).toBe(1);
    // The peer that failed is worth a warning; the one too old to share settings is not.
    expect(state.warnings).toEqual(["Could not pull shared settings from a linked machine"]);
  }),
);

it.effect("pulls nothing while linked environments is off", () =>
  Effect.gen(function* () {
    const state = yield* fresh;
    yield* pull({ ...state, linksEnabled: false });
    expect(yield* Ref.get(state.calls)).toEqual([]);
  }),
);

it.effect("pulls nothing while this machine does not follow shared settings", () =>
  Effect.gen(function* () {
    const state = yield* fresh;
    yield* pull({ ...state, follows: false });
    expect(yield* Ref.get(state.calls)).toEqual([]);
    expect(yield* Ref.get(state.retries)).toBe(0);
  }),
);
