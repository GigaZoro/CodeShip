import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const RunLoopRole = Schema.Literals([
  "interactive",
  "scheduled",
  "maintenance",
  "delegated",
]);
export type RunLoopRole = typeof RunLoopRole.Type;

export const MIN_RUN_LOOP_MAX_TURNS = 1;
export const MAX_RUN_LOOP_MAX_TURNS = 10_000;
export const RunLoopMaxTurns = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_RUN_LOOP_MAX_TURNS, maximum: MAX_RUN_LOOP_MAX_TURNS }),
);
export type RunLoopMaxTurns = typeof RunLoopMaxTurns.Type;

export const MIN_RUN_LOOP_MAX_TOOL_CALLS = 1;
export const MAX_RUN_LOOP_MAX_TOOL_CALLS = 100_000;
export const RunLoopMaxToolCalls = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_RUN_LOOP_MAX_TOOL_CALLS, maximum: MAX_RUN_LOOP_MAX_TOOL_CALLS }),
);
export type RunLoopMaxToolCalls = typeof RunLoopMaxToolCalls.Type;

export const MIN_RUN_LOOP_IDENTICAL_ERROR_THRESHOLD = 2;
export const MAX_RUN_LOOP_IDENTICAL_ERROR_THRESHOLD = 50;
export const DEFAULT_RUN_LOOP_IDENTICAL_ERROR_THRESHOLD = 3;
export const RunLoopIdenticalErrorThreshold = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_RUN_LOOP_IDENTICAL_ERROR_THRESHOLD,
    maximum: MAX_RUN_LOOP_IDENTICAL_ERROR_THRESHOLD,
  }),
);
export type RunLoopIdenticalErrorThreshold = typeof RunLoopIdenticalErrorThreshold.Type;

export const DEFAULT_RUN_LOOP_ROLE_LIMITS = {
  interactive: { maxTurns: 100, maxToolCalls: 1000 },
  scheduled: { maxTurns: 20, maxToolCalls: 150 },
  maintenance: { maxTurns: 5, maxToolCalls: 25 },
  delegated: { maxTurns: 25, maxToolCalls: 200 },
} as const satisfies Record<
  RunLoopRole,
  { readonly maxTurns: number; readonly maxToolCalls: number }
>;

const makeRoleLimitSchema = (defaults: {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
}) =>
  Schema.Struct({
    maxTurns: RunLoopMaxTurns.pipe(Schema.withDecodingDefault(Effect.succeed(defaults.maxTurns))),
    maxToolCalls: RunLoopMaxToolCalls.pipe(
      Schema.withDecodingDefault(Effect.succeed(defaults.maxToolCalls)),
    ),
  });

export const RunLoopRoleLimit = Schema.Struct({
  maxTurns: RunLoopMaxTurns,
  maxToolCalls: RunLoopMaxToolCalls,
});
export type RunLoopRoleLimit = typeof RunLoopRoleLimit.Type;

const RunLoopRoleLimitPatch = Schema.Struct({
  maxTurns: Schema.optionalKey(RunLoopMaxTurns),
  maxToolCalls: Schema.optionalKey(RunLoopMaxToolCalls),
});

export const RunLoopRoleLimits = Schema.Struct({
  interactive: makeRoleLimitSchema(DEFAULT_RUN_LOOP_ROLE_LIMITS.interactive).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  scheduled: makeRoleLimitSchema(DEFAULT_RUN_LOOP_ROLE_LIMITS.scheduled).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  maintenance: makeRoleLimitSchema(DEFAULT_RUN_LOOP_ROLE_LIMITS.maintenance).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  delegated: makeRoleLimitSchema(DEFAULT_RUN_LOOP_ROLE_LIMITS.delegated).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type RunLoopRoleLimits = typeof RunLoopRoleLimits.Type;

/**
 * Per-role turn/tool-call caps and consecutive identical-error thrash breaker for provider runs.
 * Automated roles use strict ceilings by default; interactive sessions keep high ceilings.
 */
export const RunLoopGuardSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  thrashBreakerEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  identicalErrorThreshold: RunLoopIdenticalErrorThreshold.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUN_LOOP_IDENTICAL_ERROR_THRESHOLD)),
  ),
  limits: RunLoopRoleLimits.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type RunLoopGuardSettings = typeof RunLoopGuardSettings.Type;

export const RunLoopGuardSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  thrashBreakerEnabled: Schema.optionalKey(Schema.Boolean),
  identicalErrorThreshold: Schema.optionalKey(RunLoopIdenticalErrorThreshold),
  limits: Schema.optionalKey(
    Schema.Struct({
      interactive: Schema.optionalKey(RunLoopRoleLimitPatch),
      scheduled: Schema.optionalKey(RunLoopRoleLimitPatch),
      maintenance: Schema.optionalKey(RunLoopRoleLimitPatch),
      delegated: Schema.optionalKey(RunLoopRoleLimitPatch),
    }),
  ),
});
export type RunLoopGuardSettingsPatch = typeof RunLoopGuardSettingsPatch.Type;

export const DEFAULT_RUN_LOOP_GUARD_SETTINGS: RunLoopGuardSettings = Schema.decodeSync(
  RunLoopGuardSettings,
)({});
