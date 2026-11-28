import { ProviderSetupError } from "@t3tools/contracts/providerSetup";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

const UNAUTHORIZED_STATUS = 401;

/**
 * Codex reports a refused login as a generic error ("other"), so the 401 is
 * only in its text or HTTP status: "workspace routing discovery unauthorized
 * (401)" for its own login, "unexpected status 401 Unauthorized" for a token
 * an auth command supplied.
 */
const LOGIN_REJECTED_TEXT =
  /workspace routing discovery unauthorized \(401\)|unexpected status 401 Unauthorized/iu;
// A failure that names an MCP server is that server refusing its own credentials.
const MCP_TEXT = /\bMCP\b/u;

function httpStatusCode(errorInfo: CodexSchema.ServerNotification__CodexErrorInfo | null) {
  if (typeof errorInfo !== "object" || errorInfo === null) return null;
  const detail: unknown = Object.values(errorInfo)[0];
  return typeof detail === "object" && detail !== null && "httpStatusCode" in detail
    ? detail.httpStatusCode
    : null;
}

const namesRejectedLogin = (text: string | null | undefined) =>
  text != null && LOGIN_REJECTED_TEXT.test(text) && !MCP_TEXT.test(text);

export function isCodexLoginRejected(error: {
  readonly message?: string | null;
  readonly additionalDetails?: string | null;
  readonly codexErrorInfo?: CodexSchema.ServerNotification__CodexErrorInfo | null;
}): boolean {
  return (
    error.codexErrorInfo === "unauthorized" ||
    httpStatusCode(error.codexErrorInfo ?? null) === UNAUTHORIZED_STATUS ||
    namesRejectedLogin(error.message) ||
    namesRejectedLogin(error.additionalDetails)
  );
}

/** The operation of a failure where ChatGPT refused a connection's token and renewing it did not help. */
export const CHATGPT_TOKEN_REVOKED = "token-revoked";
export const CHATGPT_TOKEN_REVOKED_DETAIL = "Your ChatGPT connection was revoked. Sign in again.";

const isSetupError = Schema.is(ProviderSetupError);

/** The ChatGPT connection keeps its saved sign-in but cannot run until the user signs in again. */
export const isChatGptTokenRevoked = (error: unknown): error is ProviderSetupError =>
  isSetupError(error) && error.operation === CHATGPT_TOKEN_REVOKED;
