import {
  type EnvironmentId,
  isListedThreadLineage,
  ThreadTag,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { EnvironmentThreadShell } from "./models.ts";
import { threadKey } from "./entities.ts";

type FilterableThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "tags" | "delegatedFrom"
>;

export interface TagFilteredEnvironment {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<FilterableThread>;
  /** Tags this environment hides, or null while its filter is off. */
  readonly hiddenTags: ReadonlyArray<string> | null;
}

export const NO_HIDDEN_THREADS: ReadonlySet<string> = new Set();

/** The thread a subagent, side chat or delegated task takes its visibility from, if any. */
export function visibilityParentKey(
  environmentId: EnvironmentId,
  thread: Pick<FilterableThread, "lineage" | "delegatedFrom">,
): string | null {
  const parentId = thread.lineage.parentThreadId;
  if (!isListedThreadLineage(thread.lineage) && parentId !== null) {
    return threadKey({ environmentId, threadId: parentId });
  }
  return thread.delegatedFrom === undefined ? null : threadKey(thread.delegatedFrom);
}

/**
 * Pull request linked-thread rows the tag filter leaves visible. Loaded threads use the
 * parent-aware hidden set. Rows the shell leaves out carry no lineage, so while any
 * environment hides tags they stay out.
 */
export function visibleLinkedThreads<Row extends { readonly id: ThreadId }>(
  rows: ReadonlyArray<Row>,
  environmentId: EnvironmentId,
  loadedThreadRefs: ReadonlyArray<ScopedThreadRef>,
  hiddenKeys: ReadonlySet<string>,
  hidingAnywhere: boolean,
): ReadonlyArray<Row> {
  if (!hidingAnywhere && hiddenKeys.size === 0) return rows;
  const loaded = new Set(loadedThreadRefs.map((ref) => ref.threadId));
  return rows.filter((row) =>
    loaded.has(row.id)
      ? !hiddenKeys.has(threadKey({ environmentId, threadId: row.id }))
      : !hidingAnywhere,
  );
}

function hasHiddenTag(
  tags: ReadonlyArray<string> | undefined,
  hiddenTags: ReadonlyArray<string> | null,
): boolean {
  return hiddenTags?.some((tag) => tags?.includes(tag) === true) === true;
}

/**
 * Keys of threads the tag filter hides. Children (subagents, side chats, delegated tasks) follow
 * their parent; while any environment hides tags, a child whose parent is not loaded stays hidden.
 * For a partial list such as an archive page, `alreadyHidden` and `loadedElsewhere` give the
 * hidden and loaded keys of live threads, and `hidingAnywhere` the global flag.
 */
export function hiddenThreadKeys(
  environments: ReadonlyArray<TagFilteredEnvironment>,
  alreadyHidden: ReadonlySet<string> = NO_HIDDEN_THREADS,
  loadedElsewhere: ReadonlySet<string> = NO_HIDDEN_THREADS,
  hidingAnywhere: boolean = environments.some((environment) => environment.hiddenTags !== null),
): ReadonlySet<string> {
  if (alreadyHidden.size === 0 && !hidingAnywhere) return NO_HIDDEN_THREADS;
  const byKey = new Map<
    string,
    { thread: FilterableThread; environment: TagFilteredEnvironment }
  >();
  for (const environment of environments) {
    for (const thread of environment.threads) {
      byKey.set(threadKey({ environmentId: environment.environmentId, threadId: thread.id }), {
        thread,
        environment,
      });
    }
  }
  const hiddenByKey = new Map<string, boolean>();
  const isHidden = (key: string): boolean => {
    if (alreadyHidden.has(key)) return true;
    const known = hiddenByKey.get(key);
    if (known !== undefined) return known;
    const entry = byKey.get(key);
    if (entry === undefined) return false;
    const { thread, environment } = entry;
    const parentKey = visibilityParentKey(environment.environmentId, thread);
    const followsParent =
      parentKey !== null && (byKey.has(parentKey) || alreadyHidden.has(parentKey));
    if (parentKey !== null && !followsParent && loadedElsewhere.has(parentKey)) {
      hiddenByKey.set(key, false);
      return false;
    }
    if (parentKey !== null && !followsParent && hidingAnywhere) {
      hiddenByKey.set(key, true);
      return true;
    }
    if (!followsParent) {
      const hidden = hasHiddenTag(thread.tags, environment.hiddenTags);
      hiddenByKey.set(key, hidden);
      return hidden;
    }
    // Seed before following the parent so a malformed cycle ends visible.
    hiddenByKey.set(key, false);
    const hidden = isHidden(parentKey);
    hiddenByKey.set(key, hidden);
    return hidden;
  };
  const hidden = new Set<string>();
  for (const key of byKey.keys()) {
    if (isHidden(key)) hidden.add(key);
  }
  return hidden.size === 0 ? NO_HIDDEN_THREADS : hidden;
}

const decodeThreadTag = Schema.decodeUnknownOption(ThreadTag);

export function parseThreadTag(value: string): string | null {
  return Option.getOrNull(decodeThreadTag(value));
}

export function collectThreadTags(
  visibleThreads: ReadonlyArray<EnvironmentThreadShell>,
): readonly string[] {
  const tags = new Set<string>();
  for (const thread of visibleThreads) {
    if (thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) continue;
    for (const tag of thread.source.tags ?? []) {
      if (parseThreadTag(tag) === tag) tags.add(tag);
    }
  }
  return [...tags].sort();
}

export interface ThreadTagTarget {
  readonly tags: readonly string[] | undefined;
  /** Tags hidden where the thread lives, or null while that environment's settings load. */
  readonly blockedTags: ReadonlyArray<string> | null;
}

/**
 * The Tags menu for `targets`: suggestions and the targets' own tags, less any hidden where a
 * target lives. Null while a target's settings load, since a hidden tag would hide its thread.
 */
export function threadTagMenuEntries(
  suggestions: readonly string[],
  targets: readonly ThreadTagTarget[],
): ReadonlyArray<{ readonly tag: string; readonly checked: boolean }> | null {
  const blocked = new Set<string>();
  for (const target of targets) {
    if (target.blockedTags === null) return null;
    for (const tag of target.blockedTags) blocked.add(tag);
  }
  const tags = new Set(suggestions);
  for (const target of targets) {
    for (const tag of target.tags ?? []) if (parseThreadTag(tag) === tag) tags.add(tag);
  }
  return [...tags]
    .filter((tag) => !blocked.has(tag))
    .sort()
    .map((tag) => ({ tag, checked: targets.every((target) => target.tags?.includes(tag)) }));
}

/** Why `tag` cannot change on every target, as `threadTagMenuEntries` decides it. */
export function threadTagBlock(
  targets: readonly ThreadTagTarget[],
  tag: string,
): "loading" | "hidden" | null {
  if (targets.some((target) => target.blockedTags === null)) return "loading";
  return targets.some((target) => target.blockedTags?.includes(tag)) ? "hidden" : null;
}

export function matchesAnyThreadTag(
  tags: readonly string[] | undefined,
  selected: ReadonlySet<string>,
): boolean {
  return selected.size === 0 || tags?.some((tag) => selected.has(tag)) === true;
}

/** Selected tags no loaded thread carries stay listed after the rest, so each can be turned off. */
export function threadTagFilterOptions(
  available: readonly string[],
  selected: readonly string[],
): readonly string[] {
  const missing = selected.filter((tag) => !available.includes(tag));
  return missing.length === 0 ? available : [...available, ...missing];
}

export function toggleThreadTagSelection(
  selected: readonly string[],
  tag: string,
): readonly string[] {
  return selected.includes(tag) ? selected.filter((value) => value !== tag) : [...selected, tag];
}
