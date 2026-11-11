import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
  type SharedSettingsShare,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";

import {
  filterSharedServerPatch,
  type MachineSettingsWrite,
  persistSharedSettingsWrites,
  planSharedSettingsWrites,
} from "./sharedSettings.ts";

describe("filterSharedServerPatch", () => {
  it("holds the restart preference until the target's config loads", () => {
    const patch = { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    expect(filterSharedServerPatch(patch, DEFAULT_SERVER_SETTINGS)).toEqual(patch);
  });

  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, settings, settings, targetIsSource)).toEqual({
        ...(targetIsSource
          ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
          : {}),
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      });
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );
});

describe("saving a change for all machines", () => {
  const machine = (
    id: string,
    options: { readonly follows?: boolean; readonly connected?: boolean } = {},
  ) => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, followSharedSettings: options.follows === true },
    },
  });
  const mac = machine("Mac", { follows: true });
  const pc = machine("PC", { follows: true });
  const vps = machine("VPS", { follows: true, connected: false });
  const cpc = machine("CPC");
  const writeTo = (
    target: ReturnType<typeof machine>,
    patch: ServerSettingsPatch,
  ): MachineSettingsWrite => ({ environmentId: target.environmentId, label: target.label, patch });
  const plan = (
    machines: ReadonlyArray<ReturnType<typeof machine>>,
    patch: ServerSettingsPatch,
    origin: ReturnType<typeof machine> | null,
  ) =>
    planSharedSettingsWrites({
      machines,
      writes: machines
        .filter((target) => target.connection.phase === "connected")
        .map((target) => writeTo(target, patch)),
      origin: origin?.environmentId ?? null,
      sharedPatch: () => patch,
      writeFor: ({ environmentId, label }) => ({ environmentId, label, patch: {} }),
    });
  const summary = (planned: ReturnType<typeof plan>) => ({
    writes: planned.writes.map(({ label, patch }) => ({ label, patch })),
    authority: planned.share?.authority ?? null,
    offlineFollowers: planned.offlineFollowers,
    noFollowerConnected: planned.noFollowerConnected,
  });

  it.each([
    [
      "reaches only followers, saved first by the edited one",
      [mac, pc, vps, cpc],
      { finalReviewByDefault: true, worktreesDirectory: "/work" },
      pc,
      {
        writes: [
          { label: "PC", patch: { finalReviewByDefault: true, worktreesDirectory: "/work" } },
          { label: "Mac", patch: { worktreesDirectory: "/work" } },
          { label: "CPC", patch: { worktreesDirectory: "/work" } },
        ],
        authority: pc.environmentId,
        offlineFollowers: ["VPS"],
        noFollowerConnected: false,
      },
    ],
    [
      "is saved first by another follower when the edited machine does not follow",
      [cpc, mac],
      { finalReviewByDefault: true },
      cpc,
      {
        writes: [{ label: "Mac", patch: { finalReviewByDefault: true } }],
        authority: mac.environmentId,
        offlineFollowers: [],
        noFollowerConnected: false,
      },
    ],
    [
      "never reaches a machine that does not follow while every follower is offline",
      [cpc, vps],
      { finalReviewByDefault: true },
      cpc,
      { writes: [], authority: null, offlineFollowers: ["VPS"], noFollowerConnected: true },
    ],
    [
      "is a plain edit of every machine when none follows",
      [cpc, machine("Laptop")],
      { finalReviewByDefault: true },
      cpc,
      {
        writes: [
          { label: "CPC", patch: { finalReviewByDefault: true } },
          { label: "Laptop", patch: { finalReviewByDefault: true } },
        ],
        authority: null,
        offlineFollowers: [],
        noFollowerConnected: false,
      },
    ],
    [
      "is a plain edit when it sets no shared setting",
      [mac, cpc],
      { worktreesDirectory: "/work" },
      mac,
      {
        writes: [
          { label: "Mac", patch: { worktreesDirectory: "/work" } },
          { label: "CPC", patch: { worktreesDirectory: "/work" } },
        ],
        authority: null,
        offlineFollowers: [],
        noFollowerConnected: false,
      },
    ],
  ] as const)("%s", (_name, machines, patch, origin, expected) => {
    expect(summary(plan(machines, patch, origin))).toEqual(expected);
  });

  const stamped: SharedSettingsShare = {
    stamp: { updatedAt: "2026-11-11T12:00:00.000Z", origin: mac.environmentId },
    values: [
      { key: "finalReviewByDefault", value: true },
      { key: "settingFromANewerBuild", value: { kept: true } },
    ],
  };
  const success = <A>(value: A) => ({ _tag: "Success" as const, value });

  it("sends the other followers the stamp and values the first one saved, as it sent them", async () => {
    const saved: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, finalReviewByDefault: true };
    const share = vi.fn(async (_request: unknown) => success({ settings: saved, share: stamped }));
    const update = vi.fn(async (_request: { environmentId: EnvironmentId }) => success(saved));
    const outcomes = await persistSharedSettingsWrites(
      plan([mac, pc, cpc], { finalReviewByDefault: true, worktreesDirectory: "/work" }, mac),
      { update, share },
    );
    expect(share.mock.calls).toEqual([
      [
        {
          environmentId: mac.environmentId,
          input: { patch: { finalReviewByDefault: true, worktreesDirectory: "/work" } },
        },
      ],
    ]);
    // The machine outside the group is written meanwhile; the follower waits for the stamp.
    expect(update.mock.calls.map(([request]) => request)).toEqual([
      { environmentId: cpc.environmentId, input: { patch: { worktreesDirectory: "/work" } } },
      {
        environmentId: pc.environmentId,
        input: { patch: { worktreesDirectory: "/work" }, share: stamped },
      },
    ]);
    // A follower is checked against the value it was stamped with.
    expect(outcomes.map(({ write, sent }) => [write.label, sent])).toEqual([
      ["Mac", { finalReviewByDefault: true, worktreesDirectory: "/work" }],
      ["PC", { worktreesDirectory: "/work", finalReviewByDefault: true }],
      ["CPC", { worktreesDirectory: "/work" }],
    ]);
  });

  it("fails the other followers, and only them, when the first one cannot save", async () => {
    const update = vi.fn(async (_request: { environmentId: EnvironmentId }) =>
      success(DEFAULT_SERVER_SETTINGS),
    );
    const outcomes = await persistSharedSettingsWrites(
      plan([mac, pc, cpc], { finalReviewByDefault: true, worktreesDirectory: "/work" }, mac),
      {
        update,
        share: async () => {
          throw new Error("The connection dropped.");
        },
      },
    );
    expect(update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      cpc.environmentId,
    ]);
    expect(
      outcomes.map(({ write, result }) =>
        result._tag === "Success"
          ? [write.label, "saved"]
          : [write.label, String(Cause.squash(result.cause))],
      ),
    ).toEqual([
      ["Mac", "Error: The connection dropped."],
      [
        "PC",
        "SharedSettingsNotSavedError: Mac could not save this change first, so it was not sent here.",
      ],
      ["CPC", "saved"],
    ]);
  });
});
