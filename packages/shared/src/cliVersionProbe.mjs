// The npm launcher ships this module verbatim and runs it on Node 20 or newer.
export function matchesCliVersion(exitCode, stdout, expectedVersion) {
  return exitCode === 0 && /\bv(\S+)\s*$/.exec(stdout)?.[1] === expectedVersion;
}
