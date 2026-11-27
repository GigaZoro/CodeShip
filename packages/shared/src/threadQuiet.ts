/**
 * How long a thread's work has gone without an event, once that reaches `limitMs`; otherwise null.
 * Every event moves a thread's `updatedAt`, streamed output and tool progress included, so it is
 * when the work last showed progress. The scheduler stops runs quiet past their providers' limits,
 * and clients mark working threads Stalled past the limit the user set.
 */
export function quietPastLimit(input: {
  readonly lastEventAt: number;
  readonly now: number;
  readonly limitMs: number;
}): number | null {
  const quietMs = input.now - input.lastEventAt;
  return quietMs >= input.limitMs ? quietMs : null;
}
