export function workingTree(cwd: string): string;
export function recordPass(cwd: string, tree: string, base: string): void;
export function requirePass(cwd: string, localSha: string, remoteSha: string): void;
