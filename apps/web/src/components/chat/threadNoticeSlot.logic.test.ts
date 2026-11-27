// @effect-diagnostics nodeBuiltinImport:off - scans the web sources for notice surfaces.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_THREAD_NOTICE_APPEARANCE,
  nextThreadNoticeAppearance,
  resolveThreadNoticeSlot,
  threadNoticeTier,
  threadNoticeVariant,
  type ThreadNotice,
  type ThreadNoticeProducer,
  type ThreadNoticeTier,
} from "./threadNoticeSlot.logic";

type Variant = ThreadNotice["variant"];
type Row = readonly [variant: Variant, tier: ThreadNoticeTier, shownAs: Variant];

// One row set per producer: a producer added to the resolver without rows here fails to compile.
const PRODUCER_ROWS = {
  environmentUnavailable: [
    ["error", "sendBlocking", "error"],
    ["warning", "sendBlocking", "warning"],
  ],
  managedRuntimeMode: [["warning", "sendBlocking", "warning"]],
  branchMismatch: [["info", "needsYou", "info"]],
  queuedMessages: [
    ["error", "failure", "error"],
    ["info", "info", "info"],
  ],
  projectClone: [
    ["error", "failure", "error"],
    ["warning", "info", "default"],
    ["info", "info", "info"],
  ],
  serverUpdate: [
    ["error", "failure", "error"],
    ["default", "info", "default"],
  ],
  autoBalanceUpdate: [
    ["error", "failure", "error"],
    ["default", "info", "default"],
  ],
  feedback: [
    ["error", "failure", "error"],
    ["success", "info", "success"],
    ["info", "info", "info"],
  ],
  usageLimitRecovery: [["warning", "usageLimitRecovery", "default"]],
  modelFallback: [["info", "usageLimitRecovery", "info"]],
  heldComposerSend: [["default", "sendBlocking", "default"]],
  extensionStatus: [["default", "providerStatus", "default"]],
  freshSession: [["info", "info", "info"]],
  replyTo: [["default", "info", "default"]],
  providerStatus: [
    ["error", "providerStatus", "default"],
    ["warning", "providerStatus", "default"],
  ],
  usageLimits: [["info", "info", "info"]],
  linkedEnvironment: [
    ["warning", "sendBlocking", "warning"],
    ["info", "sendBlocking", "info"],
  ],
} as const satisfies Record<ThreadNoticeProducer, ReadonlyArray<Row>>;

const notice = (producer: ThreadNoticeProducer, variant: Variant, id: string = producer) => ({
  id,
  producer,
  variant,
});

describe("threadNoticeTier", () => {
  it.each(
    Object.entries(PRODUCER_ROWS).flatMap(([producer, rows]) =>
      rows.map((row) => [producer as ThreadNoticeProducer, ...row] as const),
    ),
  )("%s %s ranks %s and shows as %s", (producer, variant, tier, shownAs) => {
    expect(threadNoticeTier(notice(producer, variant))).toBe(tier);
    expect(threadNoticeVariant(notice(producer, variant))).toBe(shownAs);
  });
});

describe("resolveThreadNoticeSlot", () => {
  it("puts the most urgent notice in the slot and the rest behind it in rank order", () => {
    const notices = [
      notice("usageLimits", "info"),
      notice("feedback", "error"),
      notice("usageLimitRecovery", "warning"),
      notice("branchMismatch", "info"),
      notice("environmentUnavailable", "error"),
      notice("queuedMessages", "info"),
    ];

    const slot = resolveThreadNoticeSlot(notices, new Map());

    expect(slot.top?.id).toBe("environmentUnavailable");
    expect(slot.rest.map((entry) => entry.id)).toEqual([
      "branchMismatch",
      "feedback",
      "usageLimitRecovery",
      // Neither has been seen before, so both count as newest and keep the order they came in.
      "usageLimits",
      "queuedMessages",
    ]);
    expect(slot.restTier).toBe("needsYou");
  });

  it("shows the newest of equal notices first", () => {
    const appearance = nextThreadNoticeAppearance(
      nextThreadNoticeAppearance(EMPTY_THREAD_NOTICE_APPEARANCE, ["old"]),
      ["old", "new"],
    );

    const slot = resolveThreadNoticeSlot(
      [notice("feedback", "error", "old"), notice("projectClone", "error", "new")],
      appearance.order,
    );

    expect(slot.top?.id).toBe("new");
    expect(slot.rest.map((entry) => entry.id)).toEqual(["old"]);
    expect(slot.restTier).toBe("failure");
  });

  it("leaves the slot empty without notices", () => {
    expect(resolveThreadNoticeSlot([], new Map())).toEqual({
      top: null,
      rest: [],
      restTier: null,
    });
  });
});

describe("nextThreadNoticeAppearance", () => {
  it("keeps the same record while the notices stay the same, and forgets the ones that left", () => {
    const first = nextThreadNoticeAppearance(EMPTY_THREAD_NOTICE_APPEARANCE, ["a", "b"]);
    expect(nextThreadNoticeAppearance(first, ["b", "a"])).toBe(first);
    expect(nextThreadNoticeAppearance(first, ["a", "b", "a"])).toBe(first);

    const second = nextThreadNoticeAppearance(first, ["b"]);
    expect([...second.order]).toEqual([["b", 1]]);
    // A notice that comes back is new again.
    expect(nextThreadNoticeAppearance(second, ["b", "a"]).order.get("a")).toBe(2);
  });
});

const webSource = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const sourcesMatching = (pattern: RegExp) =>
  NodeFS.readdirSync(webSource, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => pattern.test(NodeFS.readFileSync(NodePath.join(webSource, file), "utf8")))
    .map((file) => file.split(NodePath.sep).join("/"));

it("renders thread notices only through one slot", () => {
  // A notice rendered beside the slot would stack again; give it a producer in the resolver.
  expect(sourcesMatching(/<ComposerBannerStack[\s/>]/)).toEqual([
    "components/chat/ThreadNoticeSlot.tsx",
  ]);
  // A second slot would show a second top notice; pass its notices to the composer's.
  expect(sourcesMatching(/(?<!function )useThreadNoticeSlot\(/)).toEqual([
    "components/chat/ChatComposer.tsx",
  ]);
});
