import { codexAuthorizationRequest, codexCallbackUrl } from "@t3tools/shared/codexAuthHandoff";
import {
  cancelLoopbackAuthCallback,
  receiveLoopbackAuthCallback,
} from "@t3tools/shared/loopbackAuthCallback";

export function cancelCodexAuthCallback(authorizationUrl: string) {
  cancelLoopbackAuthCallback(codexAuthorizationRequest(authorizationUrl).state);
}

export function receiveCodexAuthCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  destination?: (callbackUrl: string) => string,
  signal?: AbortSignal,
) {
  const request = codexAuthorizationRequest(authorizationUrl);
  return receiveLoopbackAuthCallback({
    request,
    validateCallback: (url) => codexCallbackUrl(url, request.redirectUri, request.state).toString(),
    openBrowser,
    portInUseMessage:
      "The ChatGPT callback port is in use on this computer. Close the other sign-in and try again, or paste the redirect URL in T3.CodeShip.",
    ...(destination ? { destination } : {}),
    ...(signal ? { signal } : {}),
  });
}
