import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  isFullSaveDue,
  markMissing,
  markPresent,
  mergeCachedSource,
  mergeScanEntry,
  SCAN_CACHE_PIECE_CHARS,
  scanCacheDocumentPieces,
  type CachedFile,
  type CachedSource,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    state: null,
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      observedAtMs: mtimeMs,
      provider: "claude",
      records,
      tailRecords: [],
      malformedRecords: 0,
      position: position(),
    });
  }
  return cache;
}

const encode = (cache: ScanCache, extra: Readonly<Record<string, unknown>> = {}) =>
  [...scanCacheDocumentPieces(cache, extra)].join("");

describe("scan cache round trip", () => {
  it("restores cached history unchanged except for Claude local placeholders", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5-5", speed: "fast" })],
      ],
      [
        "/b.jsonl",
        200,
        [
          record({
            sessionId: "session-b",
            reportedCostUsd: 1.5,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
            },
          }),
        ],
      ],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      malformedRecords: 2,
      mtimeMs: 300,
      observedAtMs: 350,
      missingSinceMs: 500,
      presentSinceMs: 450,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
        record({ provider: "grok", model: "<synthetic>", dedupeKey: "s:p:<synthetic>" }),
      ],
      tailRecords: [record({ provider: "grok", model: "<synthetic>", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    const state = initialCodexScanState();
    for (const line of [
      { type: "session_meta", payload: { id: "session-c", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "native-turn" } },
      {
        type: "event_msg",
        timestamp: "2026-08-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, output_tokens: 2 } },
        },
      },
    ])
      parseCodexLine(JSON.stringify(line), state);
    const pending = {
      ...record({
        provider: "codex",
        model: "gpt-6-astra",
        sessionId: "session-c",
        dedupeKey: null,
      }),
      unresolvedServiceTierTurnId: "native-turn",
    };
    const pendingTail = { ...pending, unresolvedServiceTierTurnId: "native-tail" };
    original.set("/codex.jsonl", {
      size: 80,
      malformedRecords: 3,
      mtimeMs: 400,
      observedAtMs: 450,
      provider: "codex",
      records: [
        record({
          provider: "codex",
          model: "gpt-6-astra",
          rateModel: "gpt-6",
          dedupeKey: null,
          speed: "ultrafast",
        }),
        pending,
      ],
      tailRecords: [pendingTail],
      position: position({ state }),
    });

    original.set("/a.jsonl", {
      ...original.get("/a.jsonl")!,
      tailRecords: [record({ dedupeKey: "msg_tail:" })],
    });
    const claude = original.get("/a.jsonl")!;
    const cached = new Map(original);
    cached.set("/a.jsonl", {
      ...claude,
      records: [...claude.records, record({ model: "<synthetic>" })],
      tailRecords: [
        ...claude.tailRecords,
        record({ model: "<synthetic>", dedupeKey: "msg_tail:" }),
      ],
    });
    const restored = decodeScanCache(JSON.parse(encode(cached, {})), TEST_FORMAT_MAP);

    expect(restored.size).toBe(4);
    expect(restored).toEqual(original);
  });

  it.each([5, 6, 7, 8])(
    "retains v%s history and compatible positions but invalidates obsolete state",
    (version) => {
      const original = cacheWith([["/gone.jsonl", 100, [record({ speed: "fast" })]]]);
      original.set("/gone-codex.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        malformedRecords: 1,
        records: [record({ provider: "codex", speed: "fast", dedupeKey: null })],
        position: position({
          state: {
            ...(version >= 6 ? initialCodexScanState() : {}),
            model: "gpt-6-astra",
            speed: "fast",
            sessionId: "session-a",
            lastUsageSignature: null,
            sawSessionMeta: true,
            suppressingForkCopies: false,
            forkCopyAnchorMs: 0,
          },
        }),
      });
      original.set("/gone-pi.jsonl", {
        ...original.get("/gone.jsonl")!,
        size: 256,
        provider: "pi",
        records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
        malformedRecords: 3,
        position: position({ state: { sessionId: "session-a" } }),
      });
      const cleanCodex = {
        ...original.get("/gone-codex.jsonl")!,
        malformedRecords: 0,
      };
      original.set("/clean-codex.jsonl", cleanCodex);
      const encoded = JSON.parse(encode(original, {}));
      const entry = encoded.files["/gone.jsonl"]!;
      const legacy = {
        ...encoded,
        version,
        files: {
          ...encoded.files,
          "/gone.jsonl": {
            s: entry.s,
            m: entry.m,
            p: entry.p,
            r: entry.r,
            t: entry.t,
            o: entry.o,
            gl: entry.gl,
            gh: entry.gh,
            cs: entry.cs,
          },
        },
      };

      const restored = decodeScanCache(JSON.parse(JSON.stringify(legacy)), TEST_FORMAT_MAP);
      expect(restored.get("/gone.jsonl")).toEqual({
        ...original.get("/gone.jsonl"),
        needsReparse: true,
        legacy: true,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
      expect(restored.get("/gone-codex.jsonl")).toEqual({
        ...original.get("/gone-codex.jsonl"),
        needsReparse: true,
        legacy: true,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
      expect(restored.get("/clean-codex.jsonl")).toEqual(
        version >= 8
          ? { ...cleanCodex, legacy: true }
          : {
              ...cleanCodex,
              needsReparse: true,
              legacy: true,
              position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
            },
      );
      expect(restored.get("/gone-pi.jsonl")).toEqual(
        version >= 6
          ? { ...original.get("/gone-pi.jsonl"), legacy: true }
          : {
              ...original.get("/gone-pi.jsonl"),
              needsReparse: true,
              legacy: true,
              position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
            },
      );
    },
  );

  it("re-parses a Claude transcript cached before advisor usage was counted", () => {
    const original = cacheWith([["/claude.jsonl", 100, [record()]]]);
    const v9 = { ...JSON.parse(encode(original, {})), version: 9 };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(v9)), TEST_FORMAT_MAP);
    expect(restored.get("/claude.jsonl")).toEqual({
      ...original.get("/claude.jsonl"),
      needsReparse: true,
      legacy: true,
      position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
    expect(decodeScanCache(JSON.parse(encode(restored, {})), TEST_FORMAT_MAP)).toEqual(restored);
  });

  it("encodes a large cache in pieces of bounded size that restore the whole cache", () => {
    const cache = cacheWith(
      Array.from({ length: 1000 }, (_, file) => [
        `/projects/${file}.jsonl`,
        100 + file,
        Array.from({ length: 60 }, (_, line) => record({ dedupeKey: `msg_${file}_${line}:` })),
      ]),
    );
    const sources = { "claude\u0000/projects": { dir: "/projects", volumeId: "1:2" } };
    const rowChars = Math.max(...[...cache].map((row) => encode(new Map([row])).length));
    const pieces = [...scanCacheDocumentPieces(cache, { sources })];

    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThan(SCAN_CACHE_PIECE_CHARS + rowChars);
    }
    const document = JSON.parse(pieces.join(""));
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
    expect(document.sources).toEqual(sources);
  });

  it("names only the sessions and models of the rows each document holds", () => {
    const cache = cacheWith([
      ["/a.jsonl", 100, [record()]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b", model: "claude-opus-5-5" })]],
    ]);
    expect(JSON.parse(encode(cache)).sessions).toEqual(["session-a", "session-b"]);

    cache.delete("/a.jsonl");
    const document = JSON.parse(encode(cache));
    expect(document).toMatchObject({ models: ["claude-opus-5-5"], sessions: ["session-b"] });
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
  });

  it.each([
    { case: "most rows changed", liveRows: 4, staleRows: 3, retirableChars: [], due: true },
    { case: "half the rows changed", liveRows: 4, staleRows: 2, retirableChars: [], due: false },
    {
      case: "too many snapshots",
      liveRows: 4,
      staleRows: 0,
      retirableChars: [1000, ...Array.from({ length: 64 }, () => 1)],
      due: true,
    },
    {
      case: "the most snapshots allowed",
      liveRows: 4,
      staleRows: 0,
      retirableChars: [1000, ...Array.from({ length: 63 }, () => 1)],
      due: false,
    },
    {
      case: "more saved beside the largest",
      liveRows: 4,
      staleRows: 0,
      retirableChars: [100, 60, 41],
      due: true,
    },
    {
      case: "as much saved beside the largest",
      liveRows: 4,
      staleRows: 0,
      retirableChars: [100, 60, 40],
      due: false,
    },
  ])("is due for a full save with $case: $due", ({ due, ...input }) => {
    expect(isFullSaveDue(input)).toBe(due);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    expect(decodeScanCache(null, TEST_FORMAT_MAP).size).toBe(0);
    expect(decodeScanCache("nonsense", TEST_FORMAT_MAP).size).toBe(0);
    expect(
      decodeScanCache({ version: 999, models: [], sessions: [], files: {} }, TEST_FORMAT_MAP).size,
    ).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = JSON.parse(encode(cacheWith([["/good.jsonl", 100, [record()]]]), {}));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it.each([
    ["a string", "500", undefined],
    ["NaN", Number.NaN, undefined],
    ["a negative time", -1, undefined],
    ["a fraction", 1.5, undefined],
    // The service counts a time ahead of its clock from now, so the decoder keeps it.
    ["far ahead of the clock", 1e15, 1e15],
  ])("keeps a row whose presence times are %s", (_name, time, decoded) => {
    const encoded = JSON.parse(encode(cacheWith([["/a.jsonl", 100, [record()]]]), {}));
    const document = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"], ms: time, ps: time } },
    };

    const restored = decodeScanCache(document, TEST_FORMAT_MAP).get("/a.jsonl");
    expect(restored?.records).toHaveLength(1);
    expect(restored?.missingSinceMs).toBe(decoded);
    expect(restored?.presentSinceMs).toBe(decoded);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    const encoded = JSON.parse(
      encode(cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]), {}),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP);
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});

describe("scan cache merge", () => {
  const row = (overrides: Partial<CachedFile> = {}): CachedFile => ({
    size: 100,
    mtimeMs: 1_000,
    observedAtMs: 2_000,
    provider: "claude",
    records: [record()],
    tailRecords: [],
    malformedRecords: 0,
    position: position(),
    ...overrides,
  });

  it.each([
    ["the later observation over a larger file", row({ observedAtMs: 2_001 }), row({ size: 900 })],
    [
      "a current row over a legacy row seen at the same time",
      row(),
      row({ legacy: true, size: 900 }),
    ],
    [
      "a current row over a row that needs a re-parse",
      row(),
      row({ needsReparse: true, size: 900 }),
    ],
    [
      "the larger of two legacy rows",
      row({ legacy: true, size: 200 }),
      row({ needsReparse: true }),
    ],
    ["the larger of two current rows", row({ size: 200 }), row()],
    [
      "a read whose speed tier resolved over the same read before it did",
      row(),
      row({ records: [record({ unresolvedServiceTierTurnId: "turn-a" })] }),
    ],
    [
      "the read with fewer unresolved speed tiers counting its tail",
      row({ tailRecords: [record()] }),
      row({ tailRecords: [record({ unresolvedServiceTierTurnId: "turn-b" })] }),
    ],
  ])("keeps %s in either order", (_name, winner, loser) => {
    expect(mergeScanEntry(winner, loser)).toBe(winner);
    expect(mergeScanEntry(loser, winner)).toBe(winner);
    expect(mergeScanEntry(winner, winner)).toBe(winner);
  });

  it("keeps the held row when nothing tells two rows apart", () => {
    const held = row();
    expect(mergeScanEntry(held, row())).toBe(held);
  });

  it.each([
    [
      "a missing time found after the winning read",
      row({ observedAtMs: 2_001 }),
      row({ missingSinceMs: 3_000 }),
      3_000,
    ],
    [
      "no missing time from before the winning read",
      row({ observedAtMs: 4_000 }),
      row({ missingSinceMs: 3_000 }),
      undefined,
    ],
    [
      "the later of two missing times for one read",
      row({ missingSinceMs: 3_000 }),
      row({ missingSinceMs: 5_000 }),
      5_000,
    ],
    [
      "no missing time from before a listing found the file back",
      row({ presentSinceMs: 3_000 }),
      row({ missingSinceMs: 2_500 }),
      undefined,
    ],
    [
      "a missing time from after a listing found the file back",
      row({ presentSinceMs: 3_000 }),
      row({ missingSinceMs: 4_000 }),
      4_000,
    ],
  ])("gives the winning row %s in either order", (_name, left, right, missingSinceMs) => {
    const observedAtMs = Math.max(left.observedAtMs, right.observedAtMs);
    const presentSinceMs = left.presentSinceMs ?? right.presentSinceMs;
    for (const merged of [mergeScanEntry(left, right), mergeScanEntry(right, left)]) {
      expect(merged.missingSinceMs).toBe(missingSinceMs);
      expect(merged.presentSinceMs).toBe(presentSinceMs);
      expect(merged.observedAtMs).toBe(observedAtMs);
    }
  });

  it.each([
    ["the same millisecond", 3_000],
    ["a clock stepped back", 2_000],
  ])("keeps a file's missing time and its return in order when they come in %s", (_name, atMs) => {
    const missing = markMissing(row({ presentSinceMs: 3_000 }), atMs);
    expect(mergeScanEntry(missing, missing).missingSinceMs).toBe(3_001);
    expect(mergeScanEntry(markPresent(missing, atMs), missing).missingSinceMs).toBeUndefined();
  });

  it("keeps the later source and fills its volume from the same directory", () => {
    const later: CachedSource = { dir: "/projects", volumeId: "", seenAtMs: 2 };
    const earlier: CachedSource = { dir: "/projects", volumeId: "1:2", seenAtMs: 1 };
    const moved: CachedSource = { dir: "/elsewhere", volumeId: "3:4", seenAtMs: 1 };
    const filled = { ...later, volumeId: "1:2" };

    expect(mergeCachedSource(later, earlier)).toEqual(filled);
    expect(mergeCachedSource(earlier, later)).toEqual(filled);
    expect(mergeCachedSource(filled, earlier)).toBe(filled);
    expect(mergeCachedSource(later, moved)).toBe(later);
    expect(mergeCachedSource({ dir: "/projects", volumeId: "1:2" }, later)).toEqual(filled);
  });
});
