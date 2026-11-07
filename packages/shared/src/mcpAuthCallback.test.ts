import { assert, it } from "@effect/vitest";

import { mcpAuthorizationRequest, mcpCallbackUrl, mcpRedirect } from "./mcpAuthCallback.ts";

const authorizationUrl =
  "https://minions.example/oauth/authorize?response_type=code&state=s7Ate&redirect_uri=http%3A%2F%2F127.0.0.1%3A62974%2Fcallback%2Fk3y";

it("mcpCallbackUrl only lets a pasted address reach this sign-in's loopback page", () => {
  const redirect = mcpRedirect(authorizationUrl);
  assert.isDefined(redirect);
  if (!redirect) return;
  const callback = "http://127.0.0.1:62974/callback/k3y?code=abc&state=s7Ate";

  assert.equal(mcpCallbackUrl(callback, redirect), callback);
  // Address bars can hide the scheme.
  assert.equal(
    mcpCallbackUrl("127.0.0.1:62974/callback/k3y?code=abc&state=s7Ate", redirect),
    callback,
  );
  assert.isDefined(
    mcpCallbackUrl("http://127.0.0.1:62974/callback/k3y?error=access_denied&state=s7Ate", redirect),
  );
  for (const rejected of [
    "http://127.0.0.1:62974/callback/k3y?code=abc&state=other",
    "http://127.0.0.1:62974/callback/k3y?code=abc",
    "http://127.0.0.1:62974/callback/k3y?state=s7Ate",
    "http://127.0.0.1:62974/callback/k3y?code=abc&error=x&state=s7Ate",
    "http://127.0.0.1:62974/callback/k3y?code=abc&state=s7Ate&state=s7Ate",
    "http://127.0.0.1:9999/callback/k3y?code=abc&state=s7Ate",
    "http://127.0.0.1:62974/elsewhere?code=abc&state=s7Ate",
    "http://evil.example:62974/callback/k3y?code=abc&state=s7Ate",
    "http://me:pw@127.0.0.1:62974/callback/k3y?code=abc&state=s7Ate",
    "not a url",
  ]) {
    assert.isUndefined(mcpCallbackUrl(rejected, redirect), rejected);
  }

  assert.isUndefined(
    mcpRedirect(
      "https://x.example/authorize?state=s&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback",
    ),
  );
});

const request = (redirectUri: string, extra = "", base = "https://auth.example/authorize") =>
  `${base}?state=s7Ate&redirect_uri=${encodeURIComponent(redirectUri)}${extra}`;

it("mcpAuthorizationRequest accepts a loopback redirect with a port and nothing else", () => {
  for (const redirectUri of [
    "http://localhost:52843/callback",
    "http://127.0.0.1:52843/callback",
    "http://[::1]:52843/callback",
  ]) {
    const parsed = mcpAuthorizationRequest(request(redirectUri));
    assert.equal(parsed.redirectUri, redirectUri);
    assert.equal(parsed.state, "s7Ate");
  }
  assert.doesNotThrow(() =>
    mcpAuthorizationRequest(request("http://localhost:52843/cb", "", "http://localhost:9000/a")),
  );

  for (const rejected of [
    request("http://localhost/callback"),
    request("http://localhost:0/callback"),
    request("http://localhost:70000/callback"),
    request("https://localhost:52843/callback"),
    request("http://evil.example:52843/callback"),
    request("http://me:pw@localhost:52843/callback"),
    request("http://localhost:52843/callback#frag"),
    request("http://localhost:52843/callback", "&state=other"),
    request("http://localhost:52843/callback", "&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fx"),
    request("http://localhost:52843/callback", "", "http://auth.example/authorize"),
    request("http://localhost:52843/callback", "", "file:///authorize"),
    `${request("http://localhost:52843/callback")}#frag`,
    "https://me:pw@auth.example/authorize?state=s&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fx",
    "https://auth.example/authorize?state=&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fx",
    "https://auth.example/authorize?state=s",
    `${request("http://localhost:52843/callback")}&pad=${"a".repeat(16_400)}`,
    "not a url",
  ]) {
    assert.throws(() => mcpAuthorizationRequest(rejected), "Invalid MCP sign-in request.");
  }
});
