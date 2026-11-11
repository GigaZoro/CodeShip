// @effect-diagnostics-next-line nodeBuiltinImport:off -- only a token fingerprint belongs in settings.
import * as NodeCrypto from "node:crypto";

import { ClaudeSettings, ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../serverSettings.ts";

const TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN";
const TOKEN_PREFIX = "sk-ant-oat01-";
const TOKEN_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const fingerprint = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
const decodeConfig = Schema.decodeUnknownSync(ClaudeSettings);

export class ClaudeOAuthTokenOutput {
  private pending = "";
  private capturing = false;
  private captured = "";
  private oversized = false;
  private token: string | undefined;
  private escape = "";

  write(data: string): string {
    let safe = "";
    for (const character of data) {
      if (this.escape || character === "\x1b") {
        this.escape += character;
        const complete =
          this.escape.length > 1 &&
          (this.escape[1] === "["
            ? this.escape.length > 2 && /[@-~]/.test(character)
            : this.escape[1] === "]"
              ? character === "\x07" || this.escape.endsWith("\x1b\\")
              : true);
        if (complete) {
          safe += this.escape.replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, "••••");
          this.escape = "";
        }
        continue;
      }
      if (this.capturing) {
        if (/^[A-Za-z0-9_-]$/.test(character)) {
          if (this.captured.length < 8192) this.captured += character;
          else this.oversized = true;
          continue;
        }
        this.finishToken();
      }
      this.pending += character;
      while (this.pending && !TOKEN_PREFIX.startsWith(this.pending)) {
        safe += this.pending[0];
        this.pending = this.pending.slice(1);
      }
      if (this.pending === TOKEN_PREFIX) {
        safe += "••••";
        this.pending = "";
        this.capturing = true;
        this.captured = TOKEN_PREFIX;
        this.oversized = false;
      }
    }
    return safe;
  }

  finish(): { readonly output: string; readonly token: string | undefined } {
    this.finishToken();
    const output = this.pending;
    this.pending = "";
    const token = this.token;
    this.token = undefined;
    return { output, token };
  }

  private finishToken(): void {
    if (this.capturing && !this.oversized && this.captured.length > TOKEN_PREFIX.length)
      this.token = this.captured;
    this.capturing = false;
    this.captured = "";
  }
}

export const saveClaudeOAuthToken = Effect.fn("ClaudeOAuthToken.save")(function* (
  instanceId: ProviderInstanceId,
  token: string | undefined,
) {
  const settings = yield* ServerSettingsService;
  const issuedAt = yield* Clock.currentTimeMillis;
  return yield* settings.updateProviderInstance((current) => {
    const instance =
      current.providerInstances[instanceId] ??
      (instanceId === "claudeAgent"
        ? { driver: ProviderDriverKind.make("claudeAgent") }
        : undefined);
    if (!instance || instance.driver !== "claudeAgent") return undefined;
    const { oauthToken: _previousToken, ...config } = decodeConfig(instance.config ?? {});
    return {
      operation: "upsert",
      instanceId,
      instance: {
        ...instance,
        environment: [
          ...(instance.environment ?? []).filter((variable) => variable.name !== TOKEN_VARIABLE),
          { name: TOKEN_VARIABLE, value: token ?? "", sensitive: token !== undefined },
        ],
        config: {
          ...config,
          ...(token === undefined
            ? {}
            : {
                oauthToken: {
                  issuedAt: DateTime.formatIso(DateTime.makeUnsafe(issuedAt)),
                  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(issuedAt + TOKEN_YEAR_MS)),
                  fingerprint: fingerprint(token),
                },
              }),
        },
      },
    };
  });
});

export function claudeOAuthTokenExpiry(
  token: string,
  metadata: ClaudeSettings["oauthToken"],
): string | undefined {
  if (!metadata || metadata.fingerprint !== fingerprint(token)) return undefined;
  return Number.isFinite(Date.parse(metadata.expiresAt)) ? metadata.expiresAt : undefined;
}
