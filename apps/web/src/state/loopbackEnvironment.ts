import type { EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import { readPreparedConnection } from "./session";

export const isLoopbackUrl = (url: string | null) =>
  url !== null && isLoopbackHost(new URL(url).hostname);

/** Whether the environment runs on this computer, so its loopback callbacks reach it directly. */
export const isLoopbackEnvironment = (environmentId: EnvironmentId) =>
  isLoopbackUrl(readPreparedConnection(environmentId)?.httpBaseUrl ?? null);

/**
 * Whether the environment's providers run on another computer. An SSH environment is reached
 * through a tunnel on this computer, so its loopback address does not mean it runs here.
 */
export const runsOnAnotherComputer = (environmentId: EnvironmentId) => {
  const connection = readPreparedConnection(environmentId);
  return (
    connection?.target._tag === "SshConnectionTarget" ||
    !isLoopbackUrl(connection?.httpBaseUrl ?? null)
  );
};
