import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/** macOS `kern.memorystatus_vm_pressure_level`: 1, 2 and 4. */
export const MemoryPressureLevel = Schema.Literals(["normal", "warn", "critical"]);
export type MemoryPressureLevel = typeof MemoryPressureLevel.Type;

/** The reading that held an automated start back, with the limit it crossed. */
export const MemoryShortage = Schema.Union([
  /** macOS. The compressor is not counted as used memory: macOS frees it to swap when needed. */
  Schema.Struct({
    kind: Schema.Literal("compressor"),
    totalBytes: NonNegativeInt,
    compressorBytes: NonNegativeInt,
    compressorShareLimit: Schema.Number,
    pressure: Schema.NullOr(MemoryPressureLevel),
  }),
  /** macOS when `vm_stat` cannot be read: the kernel's pressure level alone. */
  Schema.Struct({
    kind: Schema.Literal("pressure"),
    totalBytes: NonNegativeInt,
    pressure: Schema.Literals(["warn", "critical"]),
  }),
  /** Linux (`MemAvailable`) and Windows (free plus standby). */
  Schema.Struct({
    kind: Schema.Literal("available"),
    totalBytes: NonNegativeInt,
    availableBytes: NonNegativeInt,
    reserveBytes: NonNegativeInt,
  }),
]);
export type MemoryShortage = typeof MemoryShortage.Type;

/**
 * Across 775 readings of a 24 GB Mac the kernel reported pressure warn only from this share up; a
 * normal day reads about 0.31, and the 2026-11-13 kernel panic read 0.56.
 */
const DEFAULT_MEMORY_GUARD_COMPRESSOR_SHARE = 0.35;
const DEFAULT_MEMORY_GUARD_RESERVE_GIB = 2;

export const MemoryGuardCompressorShare = Schema.Number.check(
  Schema.isBetween({ minimum: 0.05, maximum: 1 }),
);
export const MemoryGuardReserveGiB = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1024 }),
);

/**
 * Scheduled occurrences, delegated tasks and the emulator boots agents ask for wait while memory
 * reads short. Chats the user starts are never held back.
 */
export const AutomatedStartMemoryGuard = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** macOS: short once the compressor occupies this share of physical memory. */
  compressorShare: MemoryGuardCompressorShare.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MEMORY_GUARD_COMPRESSOR_SHARE)),
  ),
  /** Linux and Windows: short once less than this much memory is available. */
  reserveGiB: MemoryGuardReserveGiB.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MEMORY_GUARD_RESERVE_GIB)),
  ),
});
export type AutomatedStartMemoryGuard = typeof AutomatedStartMemoryGuard.Type;
