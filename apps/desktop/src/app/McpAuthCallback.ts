import {
  cancelLoopbackAuthCallback,
  LoopbackPortBusyError,
  receiveLoopbackAuthCallback,
} from "@t3tools/shared/loopbackAuthCallback";
import { mcpAuthorizationRequest, mcpCallbackUrl } from "@t3tools/shared/mcpAuthCallback";

export function cancelMcpAuthCallback(authorizationUrl: string) {
  cancelLoopbackAuthCallback(mcpAuthorizationRequest(authorizationUrl).state);
}

/**
 * Catches an MCP server's loopback sign-in redirect for a provider running on another machine.
 * When the redirect cannot be caught here, the sign-in page still opens before this rejects, so
 * the user can approve and paste the browser's address into the dialog.
 */
export async function receiveMcpAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  signal?: AbortSignal,
) {
  let request: ReturnType<typeof mcpAuthorizationRequest>;
  try {
    request = mcpAuthorizationRequest(authorizationUrl);
  } catch (error) {
    await openBrowser(authorizationUrl);
    throw error;
  }
  const { expected, ...loopback } = request;
  try {
    return await receiveLoopbackAuthCallback({
      request: loopback,
      validateCallback: (url) => {
        const accepted = mcpCallbackUrl(url, expected);
        if (accepted === undefined) throw new Error("Not this sign-in's response.");
        return accepted;
      },
      openBrowser,
      portInUseMessage:
        "The sign-in port is busy on this computer. After you approve in the browser, copy its address and paste it in the Redirect address box.",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof LoopbackPortBusyError) await openBrowser(loopback.authorizationUrl);
    throw error;
  }
}
