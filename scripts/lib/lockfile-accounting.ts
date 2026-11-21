// What a merge did to pnpm-lock.yaml (automations/upstream-sync.md, step 4): every version a parent
// locked is still locked or explained, and every version neither parent locked is named for review.
// Entries are `<name>@<version>` from each document's `packages:` with the raw `resolution`; the
// first document's (the package manager pnpm installs for itself) carry the prefix `env:`.

export interface LockedPackage {
  readonly id: string;
  /** The package, `env:` included, whose versions are compared. */
  readonly group: string;
  readonly version: string;
  readonly resolution: string;
}

type Lock = ReadonlyMap<string, LockedPackage>;
type Side = "ours" | "theirs";

export interface LockfileAccount {
  /** Locked in the result but by neither parent: the install chose these itself. */
  readonly added: ReadonlyArray<string>;
  /** A parent's version the result replaced with a lower one. */
  readonly reverted: ReadonlyArray<DroppedPackage>;
  /** A parent's version the result does not lock, holding a newer one in its place or none of that package. */
  readonly dropped: ReadonlyArray<DroppedPackage>;
  /** One `<name>@<version>` that two lockfiles resolve to different code. */
  readonly mismatched: ReadonlyArray<{
    readonly id: string;
    readonly resolutions: Partial<Record<"mergeBase" | Side | "result", string>>;
  }>;
}

export interface DroppedPackage {
  readonly id: string;
  readonly side: Side;
  /** The versions of that package the result locks. */
  readonly result: ReadonlyArray<string>;
}

const ENVIRONMENT_DOCUMENT = /^ {4}(?:configDependencies|packageManagerDependencies):/m;
const ENTRY = /^ {2}(\S.*):$/;
const RESOLUTION = /^ {4}resolution: (.+)$/;

/** A key's name and version: the version starts at the first `@` after a scope's own. */
function splitKey(key: string): { readonly name: string; readonly version: string } {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  if (at <= 0) throw new Error(`pnpm-lock.yaml: ${key} is not <name>@<version>`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

export function lockedPackages(lockfile: string): Map<string, LockedPackage> {
  if (/^(?:<{7}|>{7}|={7})(?: |$)/m.test(lockfile)) {
    throw new Error(
      "pnpm-lock.yaml still has conflict markers; run `vp i --ignore-scripts` first.",
    );
  }
  const locked = new Map<string, LockedPackage>();
  for (const document of lockfile.split(/^---$/m)) {
    const prefix = ENVIRONMENT_DOCUMENT.test(document) ? "env:" : "";
    const lines = document.split("\n");
    const start = lines.indexOf("packages:");
    if (start === -1) continue;
    let current: { readonly key: string; resolution: string } | undefined;
    const flush = () => {
      if (current === undefined) return;
      const { name, version } = splitKey(current.key);
      const id = `${prefix}${name}@${version}`;
      locked.set(id, { id, group: `${prefix}${name}`, version, resolution: current.resolution });
      current = undefined;
    };
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const entry = ENTRY.exec(line);
      if (entry) {
        flush();
        current = { key: entry[1]!.replace(/^'(.*)'$/, "$1"), resolution: "" };
        continue;
      }
      const resolution = RESOLUTION.exec(line);
      if (resolution && current) current.resolution = resolution[1]!;
    }
    flush();
  }
  return locked;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/;

/** The caret range a version is in (`1.x`, or `0.3.x` below 1.0) and its parts in order, or null when it is not semver. */
function releaseLine(version: string) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  return {
    line: major === 0 ? `0.${minor}` : `${major}`,
    parts: [major, minor, patch],
    prerelease: match[4],
  };
}

type Release = NonNullable<ReturnType<typeof releaseLine>>;

/** Whether `a` is a lower version than `b`; a prerelease is lower than its release. */
function lower(a: Release, b: Release) {
  for (const [index, part] of a.parts.entries()) {
    if (part !== b.parts[index]) return part < b.parts[index]!;
  }
  if (a.prerelease === b.prerelease) return false;
  if (a.prerelease === undefined || b.prerelease === undefined) return a.prerelease !== undefined;
  return a.prerelease.localeCompare(b.prerelease) < 0;
}

/**
 * True when the result locks lower versions in `dropped`'s place: only lower ones of its release
 * line, or, holding none of that line, only lower ones at all.
 */
function isReverted(dropped: LockedPackage, result: ReadonlyArray<LockedPackage>, mergeBase: Lock) {
  const line = releaseLine(dropped.version);
  if (line === null) return result.length > 0 && result.every((other) => mergeBase.has(other.id));
  const lines = result.map((other) => releaseLine(other.version));
  const sameLine = lines.filter((other) => other?.line === line.line);
  const compared = sameLine.length > 0 ? sameLine : lines;
  return compared.length > 0 && compared.every((other) => other !== null && lower(other, line));
}

/** The result of a merge of `ours` and `theirs` (merge base `mergeBase`), each a lockfile's text. */
export function accountLockfile(lockfiles: {
  readonly mergeBase: string;
  readonly ours: string;
  readonly theirs: string;
  readonly result: string;
}): LockfileAccount {
  const locks = {
    mergeBase: lockedPackages(lockfiles.mergeBase),
    ours: lockedPackages(lockfiles.ours),
    theirs: lockedPackages(lockfiles.theirs),
    result: lockedPackages(lockfiles.result),
  };
  const resultGroups = Map.groupBy(locks.result.values(), (entry) => entry.group);
  const added = [...locks.result.keys()].filter(
    (id) => !locks.ours.has(id) && !locks.theirs.has(id),
  );
  const reverted: Array<DroppedPackage> = [];
  const dropped: Array<DroppedPackage> = [];
  for (const side of ["ours", "theirs"] as const) {
    for (const entry of locks[side].values()) {
      if (locks.mergeBase.has(entry.id) || locks.result.has(entry.id)) continue;
      const result = resultGroups.get(entry.group) ?? [];
      const record = { id: entry.id, side, result: result.map((other) => other.id).toSorted() };
      (isReverted(entry, result, locks.mergeBase) ? reverted : dropped).push(record);
    }
  }
  const ids = new Set(Object.values(locks).flatMap((lock) => [...lock.keys()]));
  const mismatched = [...ids].flatMap((id) => {
    const resolutions = Object.fromEntries(
      Object.entries(locks).flatMap(([name, lock]) => {
        const entry = lock.get(id);
        return entry === undefined ? [] : [[name, entry.resolution]];
      }),
    );
    return new Set(Object.values(resolutions)).size > 1 ? [{ id, resolutions }] : [];
  });
  const byId = (a: { readonly id: string }, b: { readonly id: string }) => a.id.localeCompare(b.id);
  return {
    added: added.toSorted(),
    reverted: reverted.toSorted(byId),
    dropped: dropped.toSorted(byId),
    mismatched: mismatched.toSorted(byId),
  };
}
