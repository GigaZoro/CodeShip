/**
 * One read of a repository's shared git state: its configuration and its branch and remote
 * refs. Every worktree of a repository shares both, so a pull request lookup over many threads
 * reads them once per repository instead of spawning git for each thread. A spawn costs a
 * Windows server's event loop about 130 ms, and a sweep over ~90 threads made hundreds.
 */

export interface RepositoryRef {
  readonly oid: string;
  readonly upstreamRemoteName: string;
  readonly upstreamRemoteRef: string;
  readonly symref: string;
}

export interface RepositorySnapshot {
  readonly config: ReadonlyMap<string, string>;
  readonly remoteNames: ReadonlyArray<string>;
  /** Each remote's first `url`, the one git fetches from; `config` keeps the last. */
  readonly remoteUrls: ReadonlyMap<string, string>;
  readonly refs: ReadonlyMap<string, RepositoryRef>;
}

export const SNAPSHOT_CONFIG_ARGS = ["config", "--list", "-z"] as const;

export const SNAPSHOT_REFS_ARGS = [
  "for-each-ref",
  "--format=%(refname)%00%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(symref)",
  "refs/heads",
  "refs/remotes",
] as const;

const REMOTE_KEY = /^remote\.(.+)\.(?:url|fetch|pushurl)$/u;

const REMOTE_URL_KEY = /^remote\.(.+)\.url$/u;

function parseConfigList(stdout: string): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (const entry of stdout.split("\u0000")) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf("\n");
    const key = separator === -1 ? entry : entry.slice(0, separator);
    entries.push([key, separator === -1 ? "" : entry.slice(separator + 1)]);
  }
  return entries;
}

function firstRemoteUrls(entries: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [key, value] of entries) {
    const name = REMOTE_URL_KEY.exec(key)?.[1];
    if (name !== undefined && !urls.has(name)) urls.set(name, value.trim());
  }
  return urls;
}

/** Names in the order git lists them: the order their sections first appear in configuration. */
function remoteNamesFromConfig(config: ReadonlyMap<string, string>): string[] {
  const names = new Set<string>();
  for (const key of config.keys()) {
    const name = REMOTE_KEY.exec(key)?.[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

function parseRefList(stdout: string): Map<string, RepositoryRef> {
  const refs = new Map<string, RepositoryRef>();
  for (const line of stdout.split("\n")) {
    const [refName = "", oid = "", upstreamRemoteName = "", upstreamRemoteRef = "", symref = ""] =
      line.trim().split("\u0000");
    if (refName.length === 0) continue;
    refs.set(refName, { oid, upstreamRemoteName, upstreamRemoteRef, symref });
  }
  return refs;
}

/** What `git symbolic-ref refs/remotes/<remote>/HEAD` names, without a spawn. */
export function defaultBranchOf(snapshot: RepositorySnapshot, remoteName: string): string | null {
  const symref = snapshot.refs.get(`refs/remotes/${remoteName}/HEAD`)?.symref ?? "";
  const prefix = `refs/remotes/${remoteName}/`;
  if (!symref.startsWith(prefix)) return null;
  const branch = symref.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

export function makeRepositorySnapshot(
  configStdout: string,
  refsStdout: string,
): RepositorySnapshot {
  const entries = parseConfigList(configStdout);
  // Later entries win, like `git config --get`.
  const config = new Map(entries);
  return {
    config,
    remoteNames: remoteNamesFromConfig(config),
    remoteUrls: firstRemoteUrls(entries),
    refs: parseRefList(refsStdout),
  };
}
