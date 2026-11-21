import { describe, expect, it } from "vite-plus/test";

import { accountLockfile, lockedPackages } from "./lockfile-accounting.ts";

/** A two-document pnpm 12 lockfile: the package manager's own entries, then the workspace graph. */
function lockfile(graph: ReadonlyArray<string>, options: { readonly tamper?: string } = {}) {
  const entry = (id: string) => {
    const key = id.startsWith("@") ? `'${id}'` : id;
    const integrity = id === options.tamper ? "sha512-other" : `sha512-${id}`;
    return `  ${key}:\n    resolution: {integrity: ${integrity}}\n    engines: {node: '>=18'}\n`;
  };
  return [
    "---",
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    configDependencies: {}",
    "    packageManagerDependencies:",
    "      pnpm:",
    "        specifier: 12.14.0",
    "        version: 12.14.0",
    "",
    "packages:",
    "",
    entry("pnpm@12.14.0"),
    "snapshots:",
    "",
    "  pnpm@12.14.0: {}",
    "",
    "---",
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "",
    "packages:",
    "",
    graph.map(entry).join("\n"),
    "snapshots:",
    "",
    ...graph.map((id) => `  ${id}: {}`),
    "",
  ].join("\n");
}

const NONE = { added: [], reverted: [], dropped: [], mismatched: [] };

describe("lockfile accounting", () => {
  it("reads each document's packages, the package manager's under env:", () => {
    const locked = lockedPackages(lockfile(["@scope/a@1.0.0", "pnpm@11.0.0"]));
    expect([...locked.keys()]).toEqual(["env:pnpm@12.14.0", "@scope/a@1.0.0", "pnpm@11.0.0"]);
    expect(locked.get("@scope/a@1.0.0")).toMatchObject({
      group: "@scope/a",
      version: "1.0.0",
      resolution: "{integrity: sha512-@scope/a@1.0.0}",
    });
  });

  it("finds nothing to report when the result holds each side's change", () => {
    const mergeBase = lockfile(["a@1.0.0", "b@1.0.0"]);
    const ours = lockfile(["a@1.1.0", "b@1.0.0"]);
    const theirs = lockfile(["a@1.0.0", "b@1.2.0", "c@2.0.0"]);
    const result = lockfile(["a@1.1.0", "b@1.2.0", "c@2.0.0"]);
    expect(accountLockfile({ mergeBase, ours, theirs, result })).toEqual(NONE);
  });

  it("reports what taking one side's lockfile and resolving again loses and invents", () => {
    const mergeBase = lockfile(["a@1.0.0", "b@1.0.0"]);
    const ours = lockfile(["a@1.1.0", "b@1.0.0"]);
    const theirs = lockfile(["a@1.0.0", "b@1.2.0", "c@2.0.0"]);
    // The fork's lockfile kept b at the merge base's version and resolved upstream's new c afresh.
    const result = lockfile(["a@1.1.0", "b@1.0.0", "c@2.1.0"]);
    expect(accountLockfile({ mergeBase, ours, theirs, result })).toEqual({
      added: ["c@2.1.0"],
      reverted: [{ id: "b@1.2.0", side: "theirs", result: ["b@1.0.0"] }],
      dropped: [{ id: "c@2.0.0", side: "theirs", result: ["c@2.1.0"] }],
      mismatched: [],
    });
  });

  it("tells a version replaced by a newer one or by nothing from one lowered", () => {
    const mergeBase = lockfile(["d@1.0.0", "e@1.0.0", "y@0.2.9", "z@0.3.1"]);
    const ours = lockfile(["d@1.1.0", "e@1.2.0", "y@0.5.0", "z@0.3.4"]);
    const theirs = mergeBase;
    // d left the graph, e kept 1.0.0 beside a new 2.x line, y went back to its 0.2 line, and z
    // moved on to a 0.4 line with nothing left on 0.3.
    const result = lockfile(["e@1.0.0", "e@2.0.0", "y@0.2.9", "z@0.4.0"]);
    expect(accountLockfile({ mergeBase, ours, theirs, result })).toEqual({
      added: ["e@2.0.0", "z@0.4.0"],
      reverted: [
        { id: "e@1.2.0", side: "ours", result: ["e@1.0.0", "e@2.0.0"] },
        { id: "y@0.5.0", side: "ours", result: ["y@0.2.9"] },
      ],
      dropped: [
        { id: "d@1.1.0", side: "ours", result: [] },
        { id: "z@0.3.4", side: "ours", result: ["z@0.4.0"] },
      ],
      mismatched: [],
    });
  });

  it("counts a prerelease as lower than its release", () => {
    const mergeBase = lockfile(["p@2.0.0-rc.1"]);
    const ours = lockfile(["p@2.0.0"]);
    const result = lockfile(["p@2.0.0-rc.1"]);
    expect(accountLockfile({ mergeBase, ours, theirs: mergeBase, result }).reverted).toEqual([
      { id: "p@2.0.0", side: "ours", result: ["p@2.0.0-rc.1"] },
    ]);
  });

  it("reports one version that two lockfiles resolve to different code", () => {
    const mergeBase = lockfile(["a@1.0.0"]);
    const result = lockfile(["a@1.0.0"], { tamper: "a@1.0.0" });
    expect(accountLockfile({ mergeBase, ours: mergeBase, theirs: mergeBase, result })).toEqual({
      ...NONE,
      mismatched: [
        {
          id: "a@1.0.0",
          resolutions: {
            mergeBase: "{integrity: sha512-a@1.0.0}",
            ours: "{integrity: sha512-a@1.0.0}",
            theirs: "{integrity: sha512-a@1.0.0}",
            result: "{integrity: sha512-other}",
          },
        },
      ],
    });
  });

  it("refuses a lockfile that still has conflict markers", () => {
    const conflicted = `${lockfile(["a@1.0.0"])}<<<<<<< HEAD\n  a@1.1.0:\n=======\n>>>>>>> upstream\n`;
    expect(() => lockedPackages(conflicted)).toThrow(/conflict markers/);
  });
});
