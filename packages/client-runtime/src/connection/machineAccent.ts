import type { EnvironmentId } from "@t3tools/contracts";

/** Badge backgrounds, dark enough for white text in light and dark themes (at least 4.5:1). */
const MACHINE_ACCENT_COLORS = [
  "#0369a1",
  "#047857",
  "#6d28d9",
  "#b45309",
  "#be123c",
  "#0f766e",
  "#4338ca",
  "#a21caf",
] as const;

export interface MachineAccent {
  readonly color: (typeof MACHINE_ACCENT_COLORS)[number];
  readonly initial: string;
}

// FNV-1a: tiny, stable across platforms, and spreads similar ids apart.
function hashEnvironmentId(environmentId: EnvironmentId): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < environmentId.length; index += 1) {
    hash ^= environmentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The machine's colour comes from its id, so two PCs that share a name and an icon still look
 * different, and the same machine looks the same on every client. The initial is the label's
 * first letter or digit, so colour is never the only cue.
 */
export function machineAccent(environmentId: EnvironmentId, label: string): MachineAccent {
  const initial = /[\p{L}\p{N}]/u.exec(label)?.[0]?.toLocaleUpperCase() ?? "?";
  const color =
    MACHINE_ACCENT_COLORS[hashEnvironmentId(environmentId) % MACHINE_ACCENT_COLORS.length]!;
  return { color, initial };
}
