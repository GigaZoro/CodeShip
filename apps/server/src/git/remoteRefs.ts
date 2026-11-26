export function parseRemoteNamesInGitOrder(stdout: string): ReadonlyArray<string> {
  return stdout.split(/\r?\n/).filter((name) => name.length > 0);
}

export function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return parseRemoteNamesInGitOrder(stdout).toSorted((a, b) => b.length - a.length);
}

export function parseRemoteRefWithRemoteNames(
  ref: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; branchName: string } | null {
  if (ref.length === 0) {
    return null;
  }

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!ref.startsWith(remotePrefix)) {
      continue;
    }
    const branchName = ref.slice(remotePrefix.length);
    if (branchName.length === 0) {
      return null;
    }
    return {
      remoteRef: ref,
      remoteName,
      branchName,
    };
  }

  return null;
}

export function extractBranchNameFromRemoteRef(
  ref: string,
  options?: {
    remoteName?: string | null;
    remoteNames?: ReadonlyArray<string>;
  },
): string {
  if (ref.length === 0) {
    return "";
  }

  if (ref.startsWith("refs/remotes/")) {
    return extractBranchNameFromRemoteRef(ref.slice("refs/remotes/".length), options);
  }

  const remoteNames = options?.remoteName ? [options.remoteName] : (options?.remoteNames ?? []);
  const parsedRemoteRef = parseRemoteRefWithRemoteNames(ref, remoteNames);
  if (parsedRemoteRef) {
    return parsedRemoteRef.branchName;
  }

  const firstSlash = ref.indexOf("/");
  if (firstSlash === -1) {
    return ref;
  }
  return ref.slice(firstSlash + 1);
}
