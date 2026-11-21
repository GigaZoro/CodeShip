import { describe, expect, it } from "vite-plus/test";
import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  computeThreadMoveAvailability,
  createThreadMovePlanner,
  listedThreadMove,
  planThreadListMove,
  resolveThreadArrangementDrop,
  threadListActiveManualOrder,
  type OrderRow,
} from "./threadOrder";

function makeRow(id: string, environmentId: string, key: string | null, pinned: boolean): OrderRow {
  return {
    id: id as OrderRow["id"],
    environmentId: environmentId as OrderRow["environmentId"],
    pinOrderKey: pinned ? key : null,
    activeOrderKey: pinned ? null : key,
    createdAt: "2026-01-01T00:00:00.000Z",
    unsettledAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: pinned ? "2026-01-01T00:00:00.000Z" : null,
  };
}

function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const KEY_POOL = [
  "a",
  "b",
  "ba",
  "bb",
  "c",
  "d",
  "ca",
  "cb",
  "da",
  "db",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  null,
];

function referenceAvailability(
  ordered: readonly OrderRow[],
  allThreads: readonly OrderRow[],
  writable: ReadonlySet<EnvironmentId>,
) {
  const planner = createThreadMovePlanner({
    ordered,
    allThreads,
    section: "pinned",
    reorderableEnvironmentIds: writable,
  });
  const answers = new Map<string, { canMoveUp: boolean; canMoveDown: boolean }>();
  for (const row of ordered) {
    const movedId = `${row.environmentId}:${row.id}`;
    answers.set(movedId, {
      canMoveUp: planner(movedId, "up") !== null,
      canMoveDown: planner(movedId, "down") !== null,
    });
  }
  return answers;
}

function randomCase(rng: () => number) {
  const rowCount = 1 + Math.floor(rng() * 9);
  const rows: OrderRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const environment = rng() < 0.75 ? "env-w" : "env-x";
    const key = KEY_POOL[Math.floor(rng() * KEY_POOL.length)] ?? null;
    const id = rng() < 0.4 ? `t:${index}` : `t${index}`;
    rows.push(makeRow(id, environment, key, true));
  }
  const hidden: OrderRow[] = [];
  const hiddenCount = Math.floor(rng() * 4);
  for (let index = 0; index < hiddenCount; index += 1) {
    const key = KEY_POOL[Math.floor(rng() * KEY_POOL.length)] ?? null;
    const id = rng() < 0.4 ? `h:${index}` : `h${index}`;
    hidden.push(makeRow(id, rng() < 0.75 ? "env-w" : "env-x", key, true));
  }
  return { ordered: rows, allThreads: [...rows, ...hidden] };
}

const WRITABLE = new Set<EnvironmentId>(["env-w" as EnvironmentId]);

describe("computeThreadMoveAvailability matches the reference planner", () => {
  it("agrees across randomized sections (keys, holes, non-writable rows, hidden keys)", () => {
    for (let seed = 1; seed <= 4_000; seed += 1) {
      const rng = makeRng(seed);
      const { ordered, allThreads } = randomCase(rng);
      const batch = computeThreadMoveAvailability({
        ordered,
        allThreads,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
      });
      const reference = referenceAvailability(ordered, allThreads, WRITABLE);
      for (const [id, answer] of reference) {
        expect(
          batch.get(id) ?? { canMoveUp: false, canMoveDown: false },
          `seed ${seed} row ${id} ordered=${ordered
            .map((row) => `${row.id}:${row.pinOrderKey ?? "-"}:${row.environmentId}`)
            .join(",")}`,
        ).toEqual(answer);
      }
    }
  });

  it("locks every row while a pending reorder is in flight", () => {
    const rows = [makeRow("t0", "env-w", "a", true), makeRow("t1", "env-w", "c", true)];
    const pending = {
      section: "pinned" as const,
      orderedIds: ["env-w:t1", "env-w:t0"],
      before: new Map(),
      assignments: new Map(),
      confirmed: new Set<string>(),
      commandsComplete: false,
    };
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
      pendingOrder: pending,
    });
    expect(batch.size).toBe(0);
  });

  it("allows the fast-path walk past reserved keys and rewrites that skip matching keys (auditor cases)", () => {
    const rows = [makeRow("t0", "env-w", "f", true), makeRow("t1", "env-x", "gn", true)];
    const withThird = [...rows, makeRow("t2", "env-w", null, true)];
    const batch = computeThreadMoveAvailability({
      ordered: withThird,
      allThreads: withThird,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(withThird, withThird, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
    expect(batch.get("env-w:t0")).toEqual({ canMoveUp: false, canMoveDown: true });
  });

  it("keeps moves available for ids containing colons (composite-id parsing)", () => {
    const rows = [makeRow("thread:1", "env", "a", true), makeRow("thread:2", "env", "c", true)];
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      section: "pinned",
      reorderableEnvironmentIds: new Set<EnvironmentId>(["env" as EnvironmentId]),
    });
    const reference = referenceAvailability(
      rows,
      rows,
      new Set<EnvironmentId>(["env" as EnvironmentId]),
    );
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
    expect(batch.get("env:thread:1")).toEqual({ canMoveUp: false, canMoveDown: true });
    expect(batch.get("env:thread:2")).toEqual({ canMoveUp: true, canMoveDown: false });
  });

  it("answers empty and single-row sections without consulting hidden rows", () => {
    const hidden = [makeRow("h0", "env-w", "b", true), makeRow("h1", "env-x", null, true)];
    expect(
      computeThreadMoveAvailability({
        ordered: [],
        allThreads: hidden,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
      }).size,
    ).toBe(0);
    for (const environment of ["env-w", "env-x"]) {
      const ordered = [makeRow("t0", environment, "a", true)];
      const allThreads = [...ordered, ...hidden];
      const batch = computeThreadMoveAvailability({
        ordered,
        allThreads,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
      });
      expect(Object.fromEntries(batch)).toEqual({
        [`${environment}:t0`]: { canMoveUp: false, canMoveDown: false },
      });
      expect(Object.fromEntries(batch)).toEqual(
        Object.fromEntries(referenceAvailability(ordered, allThreads, WRITABLE)),
      );
    }
  });

  it("denies rows whose section has non-writable neighbours when the fast path fails", () => {
    const rows = [
      makeRow("t0", "env-w", null, true),
      makeRow("t1", "env-x", "c", true),
      makeRow("t2", "env-w", "d", true),
    ];
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      allThreads: rows,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(rows, rows, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
    expect(batch.get("env-x:t1")).toEqual({ canMoveUp: false, canMoveDown: false });
  });

  it("agrees on a section where every adjacency midpoint is a hidden reserved key", () => {
    const visibleKeys = generateSpreadPinOrderKeys(24);
    const hiddenKeys = visibleKeys
      .slice(0, -1)
      .map((key, index) => pinOrderKeyBetween(key, visibleKeys[index + 1]!))
      .filter((key): key is string => key != null);
    const ordered = visibleKeys.map((key, index) => makeRow(`v${index}`, "env-w", key, true));
    const hidden = hiddenKeys.map((key, index) => makeRow(`h${index}`, "env-w", key, true));
    const allThreads = [...ordered, ...hidden];
    const batch = computeThreadMoveAvailability({
      ordered,
      allThreads,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(ordered, allThreads, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
  });
});

describe("listedThreadMove", () => {
  const ordered = ["a", "filed-1", "b", "filed-2"];
  const listed = (id: string) => !id.startsWith("filed");

  it.each([
    ["b", "up", { targetId: "a", placement: "before" }],
    ["a", "down", { targetId: "b", placement: "after" }],
    ["b", "down", null],
    ["a", "up", null],
    ["missing", "up", null],
  ] as const)("moves %s %s past rows listed elsewhere", (id, direction, expected) => {
    expect(listedThreadMove(ordered, id, direction, listed)).toEqual(expected);
  });
});

describe("planThreadListMove", () => {
  it("writes keys only to the rows the list shows, around a hidden row's key", () => {
    const reserved = makeRow("reserved", "env-x", generateSpreadPinOrderKeys(3)[0]!, true);
    const a = makeRow("a", "env-w", null, true);
    const hidden = makeRow("hidden", "env-x", null, true);
    const c = makeRow("c", "env-w", null, true);
    const ordered = [reserved, a, hidden, c];

    expect(
      planThreadListMove({
        movedId: "env-w:c",
        section: "pinned",
        direction: "up",
        ordered,
        allThreads: ordered,
        arrangement: { pinned: [a, c], active: [], activeManualOrder: true },
        reorderableEnvironmentIds: WRITABLE,
      }),
    ).toEqual({
      crossSection: false,
      destination: { targetId: "env-w:a", placement: "before" },
      assignments: [
        { id: "env-w:c", orderKey: generateSpreadPinOrderKeys(3)[1] },
        { id: "env-w:a", orderKey: generateSpreadPinOrderKeys(3)[2] },
      ],
    });
  });

  it("moves past the committed neighbor after a remote reorder with the same membership", () => {
    const a = makeRow("a", "env-w", "bb", true);
    const b = makeRow("b", "env-w", "dd", true);
    const c = makeRow("c", "env-w", "ff", true);
    const reordered = [a, { ...c, pinOrderKey: "dd" }, { ...b, pinOrderKey: "ff" }];
    const input = {
      movedId: "env-w:a",
      section: "pinned",
      direction: "down",
      ordered: reordered,
      allThreads: reordered,
      arrangement: { pinned: [a, b, c], active: [], activeManualOrder: true },
      reorderableEnvironmentIds: WRITABLE,
    } as const;
    expect(planThreadListMove(input)).toEqual({
      crossSection: false,
      destination: { targetId: "env-w:b", placement: "after" },
      assignments: [{ id: "env-w:a", orderKey: pinOrderKeyBetween("ff", null) }],
    });
    expect(planThreadListMove({ ...input, ordered: reordered.slice(0, 2) })).toBeNull();
  });

  it.each([
    { sort: "default", workingShelfEnabled: true, grouped: false },
    { sort: "default", workingShelfEnabled: false, grouped: true },
    { sort: "name", workingShelfEnabled: false, grouped: false },
  ] as const)("writes no Active keys for a drop into Active ordered by %o", (options) => {
    const pinned = makeRow("pinned", "env-w", "m", true);
    const active = makeRow("active", "env-w", null, false);
    const arrangement = {
      pinned: [pinned],
      active: [active],
      activeManualOrder: threadListActiveManualOrder(options),
    };
    const input = {
      section: "active",
      ordered: [active],
      allThreads: [pinned, active],
      arrangement,
      reorderableEnvironmentIds: WRITABLE,
    } as const;

    expect(
      planThreadListMove({
        ...input,
        movedId: "env-w:pinned",
        direction: { section: "active", targetId: null, placement: "before" },
      }),
    ).toEqual({
      crossSection: true,
      destination: { section: "active", targetId: null, placement: "before" },
      assignments: [],
    });
    expect(planThreadListMove({ ...input, movedId: "env-w:active", direction: "up" })).toBeNull();
  });
});

describe("resolveThreadArrangementDrop", () => {
  const rejectAll = { pinned: () => null, active: () => null };
  const base = {
    movedId: "env:t",
    writable: true,
    planners: rejectAll,
  } as const;
  const onRow = { section: "active", targetId: "env:other", placement: "after" } as const;
  const head = { section: "active", targetId: null, placement: "before" } as const;

  it.each([
    ["pinned", head],
    ["settled", head],
    ["snoozed", head],
    ["active", null],
  ] as const)(
    "resolves a %s drop into an Active list with no manual order",
    (sourceSection, expected) => {
      expect(
        resolveThreadArrangementDrop({
          ...base,
          sourceSection,
          candidate: onRow,
          activeManualOrder: false,
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    [onRow, "settled"],
    [{ section: "settled", targetId: null, placement: "before" }, "active"],
  ] as const)("needs a writable environment for a drop at %j", (candidate, sourceSection) => {
    expect(
      resolveThreadArrangementDrop({
        ...base,
        sourceSection,
        candidate,
        activeManualOrder: false,
        writable: false,
      }),
    ).toBeNull();
  });

  it("asks the planner when Active has a manual order", () => {
    expect(
      resolveThreadArrangementDrop({
        ...base,
        sourceSection: "settled",
        candidate: onRow,
        activeManualOrder: true,
      }),
    ).toBeNull();
    expect(
      resolveThreadArrangementDrop({
        ...base,
        sourceSection: "settled",
        candidate: onRow,
        activeManualOrder: true,
        planners: { ...rejectAll, active: () => [] },
      }),
    ).toEqual(onRow);
  });
});
