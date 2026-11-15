// @effect-diagnostics nodeBuiltinImport:off -- the server sets its own scheduling priority.
import * as NodeOS from "node:os";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class ServerPriorityError extends Schema.TaggedError<ServerPriorityError>()("ServerPriorityError", {
  cause: Schema.Defect(),
}) {}

/**
 * Windows starts a child at normal priority unless its parent runs below normal, so a server
 * above normal stays ahead of the agents, builds and commands it starts. POSIX cannot raise a
 * process without privileges; AgentScope lowers the children there instead.
 */
export const raiseAboveChildren = Effect.fn("serverPriority.raiseAboveChildren")(function* () {
  if ((yield* HostProcess.Platform) !== "win32") return;
  const target = NodeOS.constants.priority.PRIORITY_ABOVE_NORMAL;
  yield* Effect.try({
    try: () => {
      // A lower number is a higher priority; keep a class someone set above this one.
      if (NodeOS.getPriority() > target) NodeOS.setPriority(target);
    },
    catch: (cause) => new ServerPriorityError({ cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not raise the server above the processes it starts", {
        cause: error.cause,
      }),
    ),
  );
});
