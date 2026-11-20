// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

/** Accept previous/current windows for token lifetime and the next window for WSL clock lag. */
export const DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS = 12 * 60 * 60 * 1000;

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS);
}

type TokenPurpose = "bootstrap" | "control";

function deriveToken(secret: string, purpose: TokenPurpose, window: number): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`t3-desktop-${purpose}:${window}`)
    .digest("hex");
}

export function currentDesktopBootstrapToken(secret: string, nowMs: number): string {
  return deriveToken(secret, "bootstrap", windowIndex(nowMs));
}

function isValidToken(
  purpose: TokenPurpose,
  secret: string,
  token: string,
  nowMs: number,
): boolean {
  const presented = Buffer.from(token);
  const current = windowIndex(nowMs);
  return [current - 1, current, current + 1].some((window) => {
    const expected = Buffer.from(deriveToken(secret, purpose, window));
    return expected.length === presented.length && NodeCrypto.timingSafeEqual(expected, presented);
  });
}

export function isValidDesktopBootstrapToken(
  secret: string,
  token: string,
  nowMs: number,
): boolean {
  return isValidToken("bootstrap", secret, token, nowMs);
}

export function currentDesktopControlToken(secret: string, nowMs: number): string {
  return deriveToken(secret, "control", windowIndex(nowMs));
}

export function isValidDesktopControlToken(secret: string, token: string, nowMs: number): boolean {
  return isValidToken("control", secret, token, nowMs);
}
