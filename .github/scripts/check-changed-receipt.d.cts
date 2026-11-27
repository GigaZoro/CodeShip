export function alternateObjectDirectory(directory: string): string;
export function workingTree(cwd: string, objects: string): string;
export function recordPass(cwd: string, tree: string, base: string): void;
export function requirePass(cwd: string, localSha: string, remoteSha: string): void;
export function sweepStaleTempDirs(options?: {
  readonly dir?: string;
  readonly maxAgeMs?: number;
  readonly now?: number;
}): number;
