const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_URL_LENGTH = 16_384;

export interface McpRedirect {
  readonly redirect: URL;
  readonly state: string;
}

/** The loopback page an MCP provider's sign-in returns to, read from the URL it hands the user. */
export function mcpRedirect(authorizationUrl: string): McpRedirect | undefined {
  try {
    const url = new URL(authorizationUrl);
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    if (!redirectUri || !state) return undefined;
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== "http:" || !LOOPBACK_HOSTS.has(redirect.hostname)) return undefined;
    return { redirect, state };
  } catch {
    return undefined;
  }
}

/**
 * Accepts only the callback for this sign-in, so a pasted address cannot send a request
 * anywhere but the provider's own loopback page.
 */
export function mcpCallbackUrl(pasted: string, expected: McpRedirect) {
  const value = pasted.trim();
  let callback: URL;
  try {
    // Browsers can hide `http://` in the address bar.
    callback = new URL(
      /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `${expected.redirect.protocol}//${value}`,
    );
  } catch {
    return undefined;
  }
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const answered =
    (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
    (errors.length === 1 && Boolean(errors[0]) && codes.length === 0);
  if (
    callback.origin !== expected.redirect.origin ||
    callback.pathname !== expected.redirect.pathname ||
    callback.username ||
    callback.password ||
    states.length !== 1 ||
    states[0] !== expected.state ||
    !answered
  ) {
    return undefined;
  }
  return callback.toString();
}

/**
 * The desktop opens this URL in a browser and listens on its redirect port, so it must be
 * strict: a remote environment chooses the URL.
 */
export function mcpAuthorizationRequest(authorizationUrl: string) {
  const invalid = () => new Error("Invalid MCP sign-in request.");
  if (authorizationUrl.length > MAX_URL_LENGTH) throw invalid();
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    throw invalid();
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.hash) throw invalid();
  const single = (key: string) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) throw invalid();
    return values[0];
  };
  const redirectUri = single("redirect_uri");
  const state = single("state");
  const parsed = mcpRedirect(authorizationUrl);
  // URL parsing already rejects ports above 65535; an explicit port 0 cannot be listened on.
  if (
    !parsed ||
    parsed.redirect.username ||
    parsed.redirect.password ||
    parsed.redirect.hash ||
    !parsed.redirect.port ||
    parsed.redirect.port === "0"
  )
    throw invalid();
  return { authorizationUrl: url.toString(), redirectUri, state, expected: parsed };
}
