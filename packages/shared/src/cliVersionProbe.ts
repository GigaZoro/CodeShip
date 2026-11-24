export const NPM_RUNTIME_VERIFICATION_MARKER = ".npm-verified";

export function matchesCliVersion(
  exitCode: number | null,
  stdout: string,
  expectedVersion: string,
): boolean {
  return exitCode === 0 && /\bv(\S+)\s*$/.exec(stdout)?.[1] === expectedVersion;
}
