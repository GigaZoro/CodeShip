import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Modal, Pressable, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { threadDragGapOffset } from "./threadDragGap";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { deriveThreadArrangementSizing } from "../../lib/layout";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import {
  environmentThreadShells,
  steadyListedThreadShellsAtom,
  steadyShellsHoldingAtom,
} from "../../state/threads";
import { sortSettledThreads, sortThreadList } from "@t3tools/client-runtime/state/thread-sort";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import {
  pendingThreadOrderAtom,
  threadDropBusyAtom,
  threadArrangementOpenAtom,
} from "../../state/thread-order";
import { queuedThreadKeysAtom } from "../../state/use-thread-outbox";
import { useThreadListActions } from "../home/useThreadListActions";
import {
  createThreadMovePlanner,
  resolveThreadArrangementDrop,
  threadDragAction,
  threadListActiveManualOrder,
  type ThreadArrangementDestination as Destination,
} from "./threadOrder";
import {
  getThreadListV2OrderedSection,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  threadListInboxReturns,
} from "./threadListV2";
import { useThreadListNow } from "./use-thread-list-now";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { msg, t, type Message } from "../../lib/i18n";

const keyOf = (thread: EnvironmentThreadShell) => scopedThreadKey(thread.environmentId, thread.id);
type Section = "pinned" | "active" | "snoozed" | "settled";
const SECTION_TITLES: Record<Section, Message> = {
  pinned: msg("Pinned"),
  active: msg("Active"),
  snoozed: msg("Snoozed"),
  settled: msg("Settled"),
};
type Row = {
  key: string;
  section: Section;
  thread?: EnvironmentThreadShell;
  more?: "show" | "retry";
  offset: number;
  height: number;
};
type Drag = {
  orderVersion: string;
  sourceSection: Section;
  thread: EnvironmentThreadShell;
  startY: number;
  translation: number;
  destination: Destination | null;
};

function ArrangementRow(props: {
  height: number;
  offset: number;
  lifted: boolean;
  dragging: boolean;
  children: ReactNode;
}) {
  const { dragging, offset, lifted } = props;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: dragging
          ? withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System })
          : offset,
      },
    ],
    opacity: lifted ? 0 : 1,
  }));
  return (
    <Reanimated.View
      style={[{ height: props.height }, style]}
      className="flex-row items-center border-b border-border-subtle px-5"
    >
      {props.children}
    </Reanimated.View>
  );
}

function DragHandle(props: {
  title: string;
  disabled: boolean;
  onStart: () => void;
  onMove: (translation: number) => void;
  onEnd: (cancelled: boolean) => void;
  onStep: (direction: "up" | "down") => void;
  sectionActions: readonly { name: "pinned" | "active" | "settled"; label: string }[];
  onSectionMove: (section: "pinned" | "active" | "settled") => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const latest = useRef(props);
  /* oxlint-disable react/refs -- The pan gesture captures its callbacks once per `disabled` change; they read the latest handlers when native gesture events fire. */
  latest.current = props;
  const gesture = useMemo(
    () =>
      // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
      Gesture.Pan()
        .enabled(!props.disabled)
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() => latest.current.onStart())
        .onUpdate((event) => latest.current.onMove(event.translationY))
        .onEnd((event) => latest.current.onMove(event.translationY))
        .onFinalize((_, success) => latest.current.onEnd(!success)),
    [props.disabled, latest],
  );
  /* oxlint-enable react/refs */
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={t("Reorder {title}", { title: props.title })}
        accessibilityHint={t(
          "Move up and Move down reorder within this section. Other actions move between sections.",
        )}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={
          props.disabled
            ? []
            : [
                ...props.sectionActions,
                ...(props.canMoveUp ? [{ name: "decrement", label: t("Move up") }] : []),
                ...(props.canMoveDown ? [{ name: "increment", label: t("Move down") }] : []),
              ]
        }
        onAccessibilityAction={({ nativeEvent }) => {
          if (props.disabled) return;
          const sectionAction = props.sectionActions.find(
            (action) => action.name === nativeEvent.actionName,
          );
          if (sectionAction) props.onSectionMove(sectionAction.name);
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        style={{
          width: 48,
          height: 48,
          alignItems: "center",
          justifyContent: "center",
          opacity: props.disabled ? 0.3 : 1,
        }}
      >
        <SymbolView
          name="line.3.horizontal"
          size={22}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}

function ThreadArrangementSheet(props: { onClose: () => void }) {
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const { rowHeight, headerHeight } = deriveThreadArrangementSizing({
    baseFontSize: appearance.baseFontSize,
    fontScale,
  });
  const threads = useAtomValue(steadyListedThreadShellsAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const queuedThreadKeys = useAtomValue(queuedThreadKeysAtom);
  const pendingOrder = useAtomValue(pendingThreadOrderAtom);
  const dropBusy = useAtomValue(threadDropBusyAtom);
  const holdingRows = useAtomValue(steadyShellsHoldingAtom);
  const { moveThread } = useThreadListActions();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const sort =
    preferences._tag === "Success"
      ? (preferences.value.threadListFilters?.sort ?? "default")
      : "default";
  const lastActivityOrder = useAtomValue(environmentThreadShells.lastActivityOrderAtom(sort));
  const { workingShelfEnabled, grouping } = useThreadListV2ShelfPreferences();
  // Folders order active threads by their latest message, so the list has no manual order.
  const grouped = grouping.project || grouping.machine;
  const now = useThreadListNow(threads);
  const [expanded, setExpanded] = useState({ snoozed: false, settled: false });
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  // Older settled threads load in pages, as in the thread list.
  const olderSettledShelf = useOlderSettledShelf({
    scopes: [...configs.keys()].map((environmentId) => ({ environmentId, projectIds: null })),
    expanded: expanded.settled,
    visibleCount: settledVisibleCount,
    filtered: false,
  });
  const sections = useMemo(() => {
    const shared = {
      threads,
      now,
      queuedThreadKeys,
      pendingOrder,
      settlementEnvironmentIds: new Set(configs.keys()),
      snoozeEnvironmentIds: new Set(configs.keys()),
    };
    const pinned = getThreadListV2OrderedSection({ ...shared, section: "pinned" });
    const active = getThreadListV2OrderedSection({ ...shared, section: "active" });
    const visible = new Set([...pinned, ...active].map(keyOf));
    const parked = threads.filter(
      (thread) => thread.archivedAt === null && !visible.has(keyOf(thread)),
    );
    const snoozed = parked.filter((thread) => effectiveSnoozed(thread, { now }));
    const settled = parked.filter((thread) => !effectiveSnoozed(thread, { now }));
    return {
      pinned,
      active:
        sort !== "default"
          ? sortThreadList(active, sort, lastActivityOrder)
          : grouped
            ? sortWorkingThreadsBySend(active)
            : workingShelfEnabled
              ? sortInboxThreadsByReturn(active, threadListInboxReturns.returnedAt)
              : active,
      snoozed: sort === "default" ? snoozed : sortThreadList(snoozed, sort, lastActivityOrder),
      // Older settled threads load in settlement order, so Settled keeps it under any sort.
      settled: sortSettledThreads(settled),
    };
  }, [
    threads,
    configs,
    now,
    queuedThreadKeys,
    pendingOrder,
    workingShelfEnabled,
    grouped,
    sort,
    lastActivityOrder,
  ]);
  const listedSettled = sections.settled.filter(olderSettledShelf.isListed);
  useOlderSettledShelfGrowth([{ shelf: olderSettledShelf, listedCount: listedSettled.length }]);
  const visibleSettled = listedSettled.slice(0, settledVisibleCount);
  const settledCount = sections.settled.length + olderSettledShelf.unloadedCount;
  const activeManualOrder = threadListActiveManualOrder({ sort, workingShelfEnabled, grouped });
  const arrangement = { pinned: sections.pinned, active: sections.active, activeManualOrder };
  const planners = useMemo(() => {
    const planner = (section: "pinned" | "active") =>
      createThreadMovePlanner({
        ordered: sections[section],
        allThreads: threads,
        section,
        reorderableEnvironmentIds:
          section === "pinned"
            ? listEnvironments.pinReorderEnvironmentIds
            : activeManualOrder
              ? listEnvironments.activeReorderEnvironmentIds
              : new Set(),
      });
    return { pinned: planner("pinned"), active: planner("active") };
  }, [sections, threads, listEnvironments, activeManualOrder]);
  const resolveDrop = (
    thread: EnvironmentThreadShell,
    sourceSection: Row["section"],
    candidate: Destination,
    currentPlanners: typeof planners,
  ) =>
    resolveThreadArrangementDrop({
      movedId: keyOf(thread),
      sourceSection,
      candidate,
      writable: listEnvironments.activeReorderEnvironmentIds.has(thread.environmentId),
      activeManualOrder,
      planners: currentPlanners,
    });
  const rows = useMemo(() => {
    const result: Row[] = [];
    let offset = 0;
    for (const section of ["pinned", "active", "snoozed", "settled"] as const) {
      if (section === "snoozed" && sections[section].length === 0) continue;
      result.push({ key: section, section, offset, height: headerHeight });
      offset += headerHeight;
      if ((section === "snoozed" || section === "settled") && !expanded[section]) continue;
      for (const thread of section === "settled" ? visibleSettled : sections[section]) {
        result.push({ key: keyOf(thread), section, thread, offset, height: rowHeight });
        offset += rowHeight;
      }
      if (section === "settled" && olderSettledShelf.failed) {
        result.push({ key: "settled-retry", section, more: "retry", offset, height: rowHeight });
        offset += rowHeight;
      }
      if (
        section === "settled" &&
        (olderSettledShelf.hasMorePages || sections.settled.length > visibleSettled.length)
      ) {
        result.push({ key: "settled-more", section, more: "show", offset, height: rowHeight });
        offset += rowHeight;
      }
    }
    return result;
  }, [
    sections,
    expanded,
    visibleSettled,
    olderSettledShelf.failed,
    olderSettledShelf.hasMorePages,
    rowHeight,
    headerHeight,
  ]);
  const list = useRef<LegendListRef>(null);
  const geometry = useRef({ height: 0, offset: 0 });
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<Drag | null>(null);
  const [translateY] = useState(() => new Animated.Value(0));
  const latest = useRef({ rows, planners, moveThread, resolveDrop });
  // oxlint-disable-next-line react/refs -- The autoscroll rAF loop started at drag start reads the current rows and planners on every frame.
  latest.current = { rows, planners, moveThread, resolveDrop };

  function stop() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    drag.current = null;
    setPreview(null);
  }
  const orderVersion = rows
    .map(
      (row) => `${row.key}:${row.height}:${row.thread?.pinOrderKey}:${row.thread?.activeOrderKey}`,
    )
    .join("|");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the in-progress drag gesture when the thread order changes underneath it
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react/set-state-in-effect -- A changed thread order cancels the in-progress drag and clears its preview; stop only touches refs and state setters.
    stop();
  }, [orderVersion]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- cancels the pending drag animation frame on unmount
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  function update(translation: number) {
    const current = drag.current;
    if (current === null) return;
    current.translation = translation;
    const { height, offset } = geometry.current;
    const y = current.startY + translation;
    translateY.setValue(Math.max(0, Math.min(height - rowHeight, y - rowHeight / 2)));
    const contentY = Math.max(0, y + offset);
    const target =
      latest.current.rows.find((row) => contentY < row.offset + row.height) ??
      latest.current.rows.at(-1);
    const destination =
      target &&
      y >= 0 &&
      y <= height &&
      (target.section === "pinned" || target.section === "active" || target.section === "settled")
        ? latest.current.resolveDrop(
            current.thread,
            current.sourceSection,
            {
              section: target.section,
              targetId: target.thread ? target.key : null,
              placement:
                !target.thread || contentY < target.offset + target.height / 2 ? "before" : "after",
            },
            latest.current.planners,
          )
        : null;
    if (
      current.destination?.targetId !== destination?.targetId ||
      current.destination?.section !== destination?.section ||
      current.destination?.placement !== destination?.placement
    ) {
      current.destination = destination;
      setPreview({ ...current });
    }
  }
  function start(row: Row) {
    if (!row.thread || preview !== null) return;
    drag.current = {
      orderVersion,
      sourceSection: row.section,
      thread: row.thread,
      startY: row.offset + row.height / 2 - geometry.current.offset,
      translation: 0,
      destination: null,
    };
    setPreview({ ...drag.current });
    update(0);
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    let last = performance.now();
    const tick = () => {
      const current = drag.current;
      if (!current) return;
      const timestamp = performance.now();
      const dt = Math.min(timestamp - last, 32);
      last = timestamp;
      const bounds = geometry.current;
      const y = current.startY + current.translation;
      const speed =
        y < 48
          ? -Math.min(1, (48 - y) / 48)
          : y > bounds.height - 48
            ? Math.min(1, (y - bounds.height + 48) / 48)
            : 0;
      const tail = latest.current.rows.at(-1);
      const maximum = Math.max(0, (tail ? tail.offset + tail.height : 0) - bounds.height);
      const offset = Math.max(0, Math.min(maximum, bounds.offset + speed * dt * 0.5));
      if (offset !== bounds.offset) {
        bounds.offset = offset;
        list.current?.scrollToOffset({ offset, animated: false });
        update(current.translation);
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }
  const visiblePreview = preview?.orderVersion === orderVersion ? preview : null;
  const sourceRow = visiblePreview
    ? rows.find((row) => row.key === keyOf(visiblePreview.thread))
    : undefined;
  const destination = visiblePreview?.destination;
  const targetRow = destination
    ? rows.find(
        (row) =>
          row.section === destination.section &&
          row.key === (destination.targetId ?? destination.section),
      )
    : undefined;
  const insertionOffset = targetRow
    ? targetRow.offset +
      (!targetRow.thread || destination?.placement === "after" ? targetRow.height : 0)
    : sourceRow?.offset;
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A Modal is its own native hierarchy, so measure its own safe area, including side
            insets for the camera, instead of the presenting screen's. */}
        <SafeAreaProvider style={{ flex: 1 }}>
          <View className="flex-1 bg-screen">
            <SafeAreaView style={{ flex: 1 }}>
              <SheetHeader
                presentation="inline"
                title={t("Arrange threads")}
                onClose={props.onClose}
                accessibilityLabel={t("Close arrange threads")}
              />
              <Text className="px-5 pb-3 text-sm text-foreground-muted">
                {sort === "default"
                  ? t("Drag to reorder, pin, or settle. Changes save when you drop.")
                  : t("Choose Default sorting to manually arrange active threads.")}
              </Text>
              <View
                onLayout={(event) => {
                  geometry.current.height = event.nativeEvent.layout.height;
                }}
                className="flex-1"
                style={{ overflow: "hidden" }}
              >
                {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- A full-screen Modal with an inline header; there is no navigation header to register with. */}
                <LegendList
                  ref={list}
                  data={rows}
                  keyExtractor={(row) => row.key}
                  extraData={{
                    visiblePreview,
                    insertionOffset,
                    dropBusy,
                    pendingOrder,
                    listEnvironments,
                    planners,
                    configs,
                  }}
                  // Rows hold their drag gesture, so each keeps its own view.
                  recycleItems={false}
                  scrollEnabled={visiblePreview === null}
                  onScroll={(event) => {
                    geometry.current.offset = event.nativeEvent.contentOffset.y;
                  }}
                  scrollEventThrottle={16}
                  getFixedItemSize={(row) => row.height}
                  renderItem={({ item }) => {
                    const thread = item.thread;
                    const planner =
                      item.section === "pinned" || item.section === "active"
                        ? planners[item.section]
                        : null;
                    const sectionActions = thread
                      ? (["pinned", "active", "settled"] as const).flatMap<{
                          name: "pinned" | "active" | "settled";
                          label: string;
                        }>((section) => {
                          if (section === item.section) return [];
                          const label = threadDragAction(item.section, section);
                          return label &&
                            resolveDrop(
                              thread,
                              item.section,
                              { section, targetId: null, placement: "before" },
                              planners,
                            )
                            ? [{ name: section, label }]
                            : [];
                        })
                      : [];
                    return (
                      <ArrangementRow
                        height={item.height}
                        dragging={visiblePreview !== null}
                        lifted={item.key === sourceRow?.key}
                        offset={
                          sourceRow && insertionOffset !== undefined
                            ? threadDragGapOffset(
                                item.offset,
                                sourceRow.offset,
                                sourceRow.height,
                                insertionOffset,
                              )
                            : 0
                        }
                      >
                        {thread ? (
                          <>
                            <Text numberOfLines={2} className="flex-1 text-base">
                              {thread.title}
                            </Text>
                            <DragHandle
                              title={thread.title}
                              disabled={
                                dropBusy ||
                                pendingOrder !== null ||
                                holdingRows ||
                                (!listEnvironments.pinReorderEnvironmentIds.has(
                                  thread.environmentId,
                                ) &&
                                  !listEnvironments.activeReorderEnvironmentIds.has(
                                    thread.environmentId,
                                  ))
                              }
                              sectionActions={sectionActions}
                              onSectionMove={(section) => {
                                void moveThread(
                                  thread,
                                  { section, targetId: null, placement: "before" },
                                  () => arrangement,
                                );
                              }}
                              canMoveUp={planner?.(item.key, "up") != null}
                              canMoveDown={planner?.(item.key, "down") != null}
                              onStep={(direction) => {
                                void moveThread(thread, direction, () => arrangement);
                              }}
                              onStart={() => start(item)}
                              onMove={update}
                              onEnd={(cancelled) => {
                                const current = drag.current;
                                if (cancelled || !current?.destination) {
                                  stop();
                                  return;
                                }
                                if (frame.current !== null) cancelAnimationFrame(frame.current);
                                frame.current = null;
                                drag.current = null;
                                void moveThread(
                                  current.thread,
                                  current.destination,
                                  () => arrangement,
                                ).finally(stop);
                              }}
                            />
                          </>
                        ) : item.more ? (
                          <Pressable
                            accessibilityRole="button"
                            disabled={item.more === "show" && olderSettledShelf.loading}
                            className="flex-1 justify-center self-stretch"
                            onPress={() => {
                              if (item.more === "retry") olderSettledShelf.retry();
                              else
                                setSettledVisibleCount(
                                  (count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT,
                                );
                            }}
                          >
                            <Text className="text-sm text-foreground-muted">
                              {item.more === "retry"
                                ? t("Could not load older threads. Retry")
                                : olderSettledShelf.loading
                                  ? t("Loading")
                                  : settledCount <= visibleSettled.length
                                    ? t("Show more")
                                    : t("Show more ({count} settled hidden)", {
                                        count: settledCount - visibleSettled.length,
                                      })}
                            </Text>
                          </Pressable>
                        ) : (
                          <Pressable
                            disabled={item.section === "pinned" || item.section === "active"}
                            className="flex-1 justify-center self-stretch"
                            onPress={() => {
                              const section = item.section;
                              if (section === "snoozed" || section === "settled")
                                setExpanded((value) => ({ ...value, [section]: !value[section] }));
                            }}
                          >
                            <Text className="text-sm font-t3-semibold text-foreground-muted">
                              {t("{section} ({count})", {
                                section: t(SECTION_TITLES[item.section]),
                                count:
                                  item.section === "settled"
                                    ? settledCount
                                    : sections[item.section].length,
                              })}
                            </Text>
                          </Pressable>
                        )}
                      </ArrangementRow>
                    );
                  }}
                />
                {visiblePreview ? (
                  <Animated.View
                    pointerEvents="none"
                    className="absolute left-5 right-5 justify-center rounded-xl border border-border bg-screen px-4"
                    style={{ top: 0, height: rowHeight, transform: [{ translateY }] }}
                  >
                    <Text
                      numberOfLines={visiblePreview.destination?.section ? 1 : 2}
                      className="text-base font-t3-medium"
                    >
                      {visiblePreview.thread.title}
                    </Text>
                    {visiblePreview.destination?.section ? (
                      <Text className="text-xs text-foreground-muted">
                        {threadDragAction(
                          visiblePreview.sourceSection,
                          visiblePreview.destination.section,
                        )}
                      </Text>
                    ) : null}
                  </Animated.View>
                ) : null}
              </View>
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  );
}

export function ThreadArrangementHost() {
  const open = useAtomValue(threadArrangementOpenAtom);
  return open ? (
    <ThreadArrangementSheet onClose={() => appAtomRegistry.set(threadArrangementOpenAtom, false)} />
  ) : null;
}
