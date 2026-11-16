import { describe, expect, it } from "@effect/vitest";

import { defaultBranchOf, makeRepositorySnapshot } from "./repositorySnapshot.ts";

const NUL = "\u0000";

describe("repositorySnapshot", () => {
  const snapshot = makeRepositorySnapshot(
    [
      `user.name\nTest${NUL}`,
      `remote.origin.url\ngit@github.com:a/b.git${NUL}`,
      `remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*${NUL}`,
      `remote.team.fork.url\nhttps://example.com/c/d.git${NUL}`,
      `branch.feature/x.remote\norigin${NUL}`,
      `core.bare${NUL}`,
      `remote.origin.url\ngit@github.com:a/renamed.git${NUL}`,
    ].join(""),
    [
      `refs/heads/feature/x${NUL}aaa${NUL}origin${NUL}refs/heads/feature/x${NUL}`,
      `refs/heads/local-only${NUL}bbb${NUL}${NUL}${NUL}`,
      `refs/remotes/origin/HEAD${NUL}ccc${NUL}${NUL}${NUL}refs/remotes/origin/main`,
      `refs/remotes/origin/main${NUL}ccc${NUL}${NUL}${NUL}`,
    ].join("\n"),
  );

  it("reads configuration the way git config --get does: the last value wins", () => {
    expect(snapshot.config.get("remote.origin.url")).toBe("git@github.com:a/renamed.git");
  });

  it("reads each remote's first URL, the one git fetches from", () => {
    expect(snapshot.remoteUrls.get("origin")).toBe("git@github.com:a/b.git");
  });

  it("keeps dots and slashes in remote and branch names", () => {
    expect(snapshot.remoteNames).toEqual(["origin", "team.fork"]);
    expect(snapshot.config.get("branch.feature/x.remote")).toBe("origin");
  });

  it("reads a branch's saved upstream from its ref", () => {
    expect(snapshot.refs.get("refs/heads/feature/x")).toEqual({
      oid: "aaa",
      upstreamRemoteName: "origin",
      upstreamRemoteRef: "refs/heads/feature/x",
      symref: "",
    });
  });

  it("names the default branch from the remote HEAD symref", () => {
    expect(defaultBranchOf(snapshot, "origin")).toBe("main");
  });

  it("has no default branch for a remote without a HEAD", () => {
    expect(defaultBranchOf(snapshot, "team.fork")).toBeNull();
  });
});
