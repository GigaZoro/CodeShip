import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MachineAvailability } from "../connection/presentation.ts";
import {
  advanceOpenThreadIncidents,
  groupThreadIncidents,
  providerInstanceKey,
  sameThreadIncidents,
  type ThreadIncidentContext,
  type ThreadIncidentInput,
} from "./threadIncidents.ts";

const vps = EnvironmentId.make("vps");
const mac = EnvironmentId.make("mac");
const claude = ProviderInstanceId.make("claude");

function thread(
  id: string,
  overrides: {
    readonly environmentId?: EnvironmentId;
    readonly status?: "running" | "failed";
    readonly errorClass?: "usage_limit" | "provider_error" | null;
    readonly resetAt?: string | null;
    readonly settled?: boolean;
  } = {},
): ThreadIncidentInput {
  const status = overrides.status ?? "running";
  return {
    id: ThreadId.make(id),
    environmentId: overrides.environmentId ?? vps,
    settledOverride: overrides.settled ? "settled" : null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    blockedOnThreadWait: false,
    runtime: {
      status,
      activeRunId: null,
      providerInstanceId: claude,
      providerName: "Claude",
      lastError: status === "failed" ? "stopped" : null,
      lastErrorClass: overrides.errorClass ?? null,
      usageLimitResetAt: overrides.resetAt ?? null,
      updatedAt: "2026-11-28T10:00:00.000Z",
    },
    latestRun: { status: status === "failed" ? "failed" : "running" },
  };
}

function context(
  machines: Record<string, MachineAvailability> = {},
  downProviders: ReadonlyArray<string> = [],
): ThreadIncidentContext {
  return {
    machineByEnvironment: new Map(
      Object.entries(machines).map(([id, value]) => [EnvironmentId.make(id), value] as const),
    ),
    downProviders: new Set(downProviders),
  };
}

const limited = (id: string, resetAt = "2026-11-28T14:00:12.000Z") =>
  thread(id, { status: "failed", errorClass: "usage_limit", resetAt });

describe("groupThreadIncidents", () => {
  it("renders N threads frozen by one offline machine as one incident", () => {
    const threads = Array.from({ length: 7 }, (_, index) => thread(`t${index}`));
    const { incidents, byThreadKey } = groupThreadIncidents(threads, context({ vps: "offline" }));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.cause).toEqual({
      kind: "machine-offline",
      key: "machine-offline:vps",
      environmentId: vps,
    });
    expect(incidents[0]!.threadKeys).toHaveLength(7);
    expect(byThreadKey.size).toBe(7);
  });

  it("groups usage-limited threads by account and reset window, to the minute", () => {
    const { incidents } = groupThreadIncidents(
      [
        limited("a", "2026-11-28T14:00:12.000Z"),
        limited("b", "2026-11-28T14:00:48.000Z"),
        limited("c", "2026-11-28T19:00:00.000Z"),
      ],
      context(),
    );
    expect(incidents.map((incident) => incident.threadKeys.length)).toEqual([2]);
    expect(incidents[0]!.cause).toMatchObject({
      kind: "usage-limit",
      providerInstanceId: claude,
      resetAt: "2026-11-28T14:00:00.000Z",
    });
  });

  it("groups failures as an outage only while their provider is down", () => {
    const failed = [
      thread("a", { status: "failed", errorClass: "provider_error" }),
      thread("b", { status: "failed", errorClass: "provider_error" }),
    ];
    expect(groupThreadIncidents(failed, context()).incidents).toEqual([]);
    const down = groupThreadIncidents(failed, context({}, [providerInstanceKey(vps, claude)]));
    expect(down.incidents[0]?.cause.kind).toBe("provider-outage");
  });

  it("leaves a lone thread, settled threads and other machines' threads out", () => {
    const { incidents, threadCountByCause } = groupThreadIncidents(
      [
        thread("a"),
        thread("b", { settled: true }),
        thread("c", { environmentId: mac }),
        thread("d", { status: "failed", errorClass: "provider_error" }),
      ],
      context({ vps: "offline" }),
    );
    expect(incidents).toEqual([]);
    expect(threadCountByCause.get("machine-offline:vps")).toBe(1);
  });

  it("does not count a frozen thread that was not running as waiting on the machine", () => {
    const { incidents } = groupThreadIncidents(
      [limited("a"), limited("b")],
      context({ vps: "offline" }),
    );
    expect(incidents).toEqual([]);
  });
});

describe("sameThreadIncidents", () => {
  const offline = context({ vps: "offline" });
  const before = groupThreadIncidents([thread("a"), thread("b")], offline);

  it("reads two groupings of the same threads as the same incidents", () => {
    const again = groupThreadIncidents([thread("a"), thread("b")], offline);
    expect(sameThreadIncidents(before, again)).toBe(true);
    expect(
      sameThreadIncidents(before, groupThreadIncidents([thread("a"), thread("c")], offline)),
    ).toBe(false);
  });
});

describe("advanceOpenThreadIncidents", () => {
  const advance = (
    open: ReadonlyMap<string, ReturnType<typeof groupThreadIncidents>["incidents"][number]>,
    threads: ReadonlyArray<ThreadIncidentInput>,
    ctx: ThreadIncidentContext,
  ) => advanceOpenThreadIncidents(open, groupThreadIncidents(threads, ctx), threads, ctx);
  const live = context({ vps: "live" });
  const ended = (result: ReturnType<typeof advance>) =>
    result.ended.map(({ incident, recovered }) => [incident.cause.key, recovered]);

  it("ends a usage limit once, recovered, when its threads resume one at a time", () => {
    const start = advance(new Map(), [limited("a"), limited("b")], live);
    expect([...start.open.keys()]).toHaveLength(1);
    const one = advance(start.open, [thread("a"), limited("b")], live);
    expect(one.ended).toEqual([]);
    expect(one.open.size).toBe(1);
    const both = advance(one.open, [thread("a"), thread("b")], live);
    expect(ended(both)).toEqual([[[...start.open.keys()][0], true]]);
    expect(both.open.size).toBe(0);
  });

  it("does not count threads archived away from a cause as a recovery", () => {
    const start = advance(new Map(), [limited("a"), limited("b")], live);
    expect(ended(advance(start.open, [], live))).toEqual([[[...start.open.keys()][0], false]]);
  });

  it("does not call a usage limit recovered when its machine goes offline instead", () => {
    const start = advance(new Map(), [limited("a"), limited("b")], live);
    const one = advance(start.open, [thread("a"), limited("b")], live);
    const offline = context({ vps: "offline" });
    expect(ended(advance(one.open, [thread("a"), limited("b")], offline))).toEqual([
      [[...start.open.keys()][0], false],
    ]);
  });

  it("ends a provider outage as recovered when the provider is back, before any retry", () => {
    const failed = [
      thread("a", { status: "failed", errorClass: "provider_error" }),
      thread("b", { status: "failed", errorClass: "provider_error" }),
    ];
    const down = context({ vps: "live" }, [providerInstanceKey(vps, claude)]);
    const start = advance(new Map(), failed, down);
    expect(ended(advance(start.open, failed, context({ vps: "live" })))).toEqual([
      [`provider-outage:${providerInstanceKey(vps, claude)}`, true],
    ]);
  });

  it("holds an offline incident through a reconnect and ends it recovered once live", () => {
    const start = advance(new Map(), [thread("a"), thread("b")], context({ vps: "offline" }));
    const connecting = advance(
      start.open,
      [thread("a"), thread("b")],
      context({ vps: "connecting" }),
    );
    expect(connecting.ended).toEqual([]);
    expect(
      ended(advance(connecting.open, [thread("a"), thread("b")], context({ vps: "live" }))),
    ).toEqual([["machine-offline:vps", true]]);
  });

  it("does not call a removed machine recovered", () => {
    const start = advance(new Map(), [thread("a"), thread("b")], context({ vps: "offline" }));
    expect(ended(advance(start.open, [], context()))).toEqual([["machine-offline:vps", false]]);
  });
});
