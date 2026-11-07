import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentSessionSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:agent-sessions:sync",
  tag: WS_METHODS.agentSessionsSync,
});
