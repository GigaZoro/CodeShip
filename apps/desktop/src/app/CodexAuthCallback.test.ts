// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests exercise the real native loopback listener without an OpenAI account.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { codexAuthDeliveryUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { receiveCodexAuthCallback, cancelCodexAuthCallback } from "./CodexAuthCallback.ts";
import { receiveMcpAuthCallback, cancelMcpAuthCallback } from "./McpAuthCallback.ts";

async function freePort() {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function request(port: number, state = "a".repeat(43)) {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
    state,
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return url.toString();
}
function callback(authorizationUrl: string) {
  const request = new URL(authorizationUrl);
  const url = new URL(request.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({
    state: request.searchParams.get("state")!,
    code: "test-code",
    client_id: "oaiapp_test",
  }).toString();
  return url.toString();
}

describe("desktop Codex callback helper", () => {
  it("binds before opening sign-in, ignores a foreign response, and returns only the code callback", async () => {
    const authorizationUrl = request(await freePort());
    const expected = callback(authorizationUrl);
    const received = await receiveCodexAuthCallback(authorizationUrl, async () => {
      const invalid = new URL(expected);
      invalid.searchParams.set("state", "foreign");
      expect((await fetch(invalid)).status).toBe(400);
      const response = await fetch(expected);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("test-code");
      return true;
    });
    expect(received).toBe(expected);
  });
  it("returns hosted web to the exact instance and environment without putting the code in its query", async () => {
    const authorizationUrl = request(await freePort());
    const expected = callback(authorizationUrl);
    const input = {
      authorizationUrl,
      returnUrl: "https://app.t3.codes/settings/providers?environmentId=remote-one&instanceId=work",
      environmentId: EnvironmentId.make("remote-one"),
      instanceId: ProviderInstanceId.make("work"),
      flowId: "flow-one",
    };
    await receiveCodexAuthCallback(
      authorizationUrl,
      async () => {
        const response = await fetch(expected, { redirect: "manual" });
        expect(response.status).toBe(303);
        const delivery = response.headers.get("location")!;
        expect(new URL(delivery).searchParams.has("code")).toBe(false);
        expect(readCodexAuthDelivery(delivery)?.callbackUrl).toBe(expected);
        expect(readCodexAuthDelivery(delivery)?.returnUrl).toBe(input.returnUrl);
        return true;
      },
      (url) => codexAuthDeliveryUrl(input, url),
    );
  });
  it("cancels and releases its listener so exact-port reauthorization can run again", async () => {
    const authorizationUrl = request(await freePort());
    await expect(
      receiveCodexAuthCallback(authorizationUrl, async () => {
        cancelCodexAuthCallback(authorizationUrl);
        return true;
      }),
    ).rejects.toThrow("cancelled");
    expect(
      await receiveCodexAuthCallback(authorizationUrl, async () => {
        await fetch(callback(authorizationUrl));
        return true;
      }),
    ).toBe(callback(authorizationUrl));
  });
  it("allows two accounts to complete independently", async () => {
    const a = request(await freePort(), "a".repeat(43));
    const b = request(await freePort(), "c".repeat(43));
    const openedA = Promise.withResolvers<void>();
    const openedB = Promise.withResolvers<void>();
    const receiveA = receiveCodexAuthCallback(a, async () => {
      openedA.resolve();
      await openedB.promise;
      await fetch(callback(a));
      return true;
    });
    const receiveB = receiveCodexAuthCallback(b, async () => {
      openedB.resolve();
      await openedA.promise;
      await fetch(callback(b));
      return true;
    });
    expect(await Promise.all([receiveA, receiveB])).toEqual([callback(a), callback(b)]);
  });
});

const ipv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = NodeNet.createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

function mcpRequest(redirectUri: string, state = "s7Ate") {
  return `https://minions.example/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    state,
    redirect_uri: redirectUri,
  }).toString()}`;
}

describe("desktop MCP callback helper", () => {
  it("answers a localhost redirect over 127.0.0.1, rejects a wrong state or path, and keeps waiting", async () => {
    const port = await freePort();
    const authorizationUrl = mcpRequest(`http://localhost:${port}/callback`);
    const expected = `http://localhost:${port}/callback?code=abc&state=s7Ate`;
    const received = await receiveMcpAuthCallback(authorizationUrl, async () => {
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=other`)).status).toBe(
        400,
      );
      expect((await fetch(`http://127.0.0.1:${port}/elsewhere?code=abc&state=s7Ate`)).status).toBe(
        400,
      );
      expect((await fetch(`http://127.0.0.1:${port}/callback?code=abc&state=s7Ate`)).status).toBe(
        200,
      );
      return true;
    });
    expect(received).toBe(expected);
  });
  // IPv6 loopback is switched off on some CI hosts, so there is nothing to bind there.
  it.skipIf(!ipv6Loopback)("also answers a localhost redirect over ::1", async () => {
    const port = await freePort();
    const received = await receiveMcpAuthCallback(
      mcpRequest(`http://localhost:${port}/callback`),
      async () => {
        expect((await fetch(`http://[::1]:${port}/callback?code=abc&state=s7Ate`)).status).toBe(
          200,
        );
        return true;
      },
    );
    expect(received).toBe(`http://localhost:${port}/callback?code=abc&state=s7Ate`);
  });
  it("still opens the sign-in page, then rejects with the MCP message, when the port is busy", async () => {
    const blocker = NodeHttp.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("address");
    const authorizationUrl = mcpRequest(`http://127.0.0.1:${address.port}/callback`);
    const opened: string[] = [];
    try {
      await expect(
        receiveMcpAuthCallback(authorizationUrl, async (url) => {
          opened.push(url);
          return true;
        }),
      ).rejects.toThrow("sign-in port is busy");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    expect(opened).toEqual([authorizationUrl]);
  });
  it("cancels, and opens a sign-in that is not a loopback redirect without listening", async () => {
    const authorizationUrl = mcpRequest(`http://localhost:${await freePort()}/callback`);
    await expect(
      receiveMcpAuthCallback(authorizationUrl, async () => {
        cancelMcpAuthCallback(authorizationUrl);
        return true;
      }),
    ).rejects.toThrow("cancelled");
    const hosted = mcpRequest("https://evil.example/callback");
    const opened: string[] = [];
    await expect(
      receiveMcpAuthCallback(hosted, async (url) => {
        opened.push(url);
        return true;
      }),
    ).rejects.toThrow("Invalid MCP sign-in request.");
    expect(opened).toEqual([hosted]);
  });
});
