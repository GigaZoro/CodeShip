export const GIT_OUTPUT_MAX_BYTES: number;
export const GIT_CALL_TIMEOUT_MS: number;
export const GIT_CALL_LIMITS: Readonly<{ timeout: number; killSignal: "SIGKILL" }>;
export const REAL_HISTORY_ENV: Readonly<Record<string, string>>;
export function markedFiles(cwd: string): string[];
export function rerunAfterTimeout<T>(read: () => T): T;
