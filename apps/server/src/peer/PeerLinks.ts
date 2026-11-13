import {
  AuthMcpClientAccess,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  EnvironmentHttpApi,
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  MCP_PEER_LINK_SOFTWARE_ID,
  type PeerLink,
  type PeerLinkCreateInput,
  PeerLinkError,
  type PeerLinkStatus,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";

const PeerHttpApi = HttpApi.make(EnvironmentHttpApi.identifier)
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth)
  .annotateMerge(EnvironmentHttpApi.annotations);

/** The redirect registered for a link. Nothing ever listens there: the code comes back in the response. */
const LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
/**
 * How long a peer's descriptor may take before a route counts as unreachable.
 * A tailnet or relayed route to a machine that is waking up takes longer.
 */
const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);

/** A usable link: where to reach the peer and the token to send there. */
export interface ResolvedPeerLink {
  readonly link: PeerLink;
  /** The first address that answered as this peer. */
  readonly url: string;
  readonly token: string;
  /** The T3.CodeShip version that address reported, read on every resolve. */
  readonly serverVersion: string;
}

export const LINKED_ENVIRONMENTS_OFF =
  "Linked environments is off on this machine. Turn it on in Settings → Machines & access → Linked environments.";

/**
 * Links from this environment to others. Linking signs this environment in to
 * the peer's `/mcp` as an outside agent with a pairing code from the peer, the
 * same MCP OAuth flow an outside agent uses, without a browser. The peer's
 * session token is kept in the server secret store; the table keeps the rest.
 */
export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    /** Whether the Linked environments beta (Settings → Machines & access → Linked environments) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    /**
     * Links the environment at `input.url`. Linking an environment again replaces its link,
     * unless `onlyNew` is set: then a stored link to it, expired or not, refuses the call.
     */
    readonly link: (
      input: PeerLinkCreateInput,
      options?: { readonly onlyNew?: boolean },
    ) => Effect.Effect<PeerLink, PeerLinkError>;
    readonly renew: (environmentId: EnvironmentId) => Effect.Effect<void, PeerLinkError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /**
     * The environment answering at `url`, or nothing when it is not a usable
     * address or does not answer as T3.CodeShip. Sends no credential.
     */
    readonly describe: (
      url: string,
    ) => Effect.Effect<
      Option.Option<{ readonly environmentId: EnvironmentId; readonly label: string }>
    >;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** Every stored link, without asking any peer whether it answers. */
    readonly listStored: Effect.Effect<ReadonlyArray<PeerLink>, PeerLinkError>;
    /** The stored link, without asking the peer whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
    /** Forgets the link here. The peer still lists the session until it is revoked there. */
    readonly unlink: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerLinkError>;
    /** An address that answers as the linked peer, with its token, ready to call. */
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerLink, PeerLinkError>;
    /** Records the outcome of a call, so listing shows whether the peer answered last time. */
    readonly recordOutcome: (
      environmentId: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
  }
>()("t3/peer/PeerLinks") {}

interface PeerLinkRow {
  readonly environment_id: string;
  readonly secret_name: string;
  readonly label: string;
  readonly urls_json: string;
  readonly access: string;
  readonly linked_at: string;
  readonly expires_at: string;
  readonly last_reached_at: string | null;
  readonly last_error: string | null;
  readonly fenced: number;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccess = Schema.decodeUnknownEffect(AuthMcpClientAccess);

/** Fails with a fixed storage error that keeps its cause; the log gets the details. */
const failStorage = (cause: unknown) =>
  Effect.logWarning("Peer link storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerLinkError({
          reason: "storage",
          message:
            "Linked environments could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

/**
 * The base URL a peer is reached at, normalised to its origin. The pairing
 * code and then the link's token travel to it, so plain http is accepted only
 * where the network already encrypts: this machine, or a Tailscale address.
 */
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is not an http or https address.`,
      }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is plain http, which would send the link's credentials unencrypted. Use its https address, or its Tailscale address.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

/** Whether a peer holds a linked agent to its limits and keeps its work within its link. */
const linkLimitsHold = (peer: { readonly capabilities: ExecutionEnvironmentCapabilities }) =>
  peer.capabilities.mcpModeLimitHeader === true && peer.capabilities.linkFence === true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  /** A fresh name for one link's token; the row records it. */
  const newSecretName = crypto.randomBytes(16).pipe(
    Effect.map((bytes) => `peer-link-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  // Only the origin `peerOrigin` checked may receive a pairing code or token:
  // a redirect could forward them anywhere, including plain http.
  const peerHttpClient = HttpClient.transform(httpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(PeerHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, peerHttpClient),
    );

  /** The environment answering at `origin`, or nothing when it does not answer as T3.CodeShip. */
  const describe = (origin: string) =>
    clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      Effect.timeout(probeTimeout(origin)),
      Effect.option,
    );

  const toLink = Effect.fn("PeerLinks.toLink")(function* (row: PeerLinkRow) {
    return {
      environmentId: EnvironmentId.make(row.environment_id),
      label: row.label,
      urls: yield* decodeUrls(row.urls_json),
      access: yield* decodeAccess(row.access),
      linkedAt: DateTime.makeUnsafe(row.linked_at),
      // Its token predates link fencing, so the peer would not fence its work:
      // like an expired link, only a new pairing code brings it back.
      expiresAt: DateTime.makeUnsafe(row.fenced === 1 ? row.expires_at : row.linked_at),
      lastReachedAt: row.last_reached_at === null ? null : DateTime.makeUnsafe(row.last_reached_at),
      lastError: row.last_error,
    } satisfies PeerLink;
  }, Effect.catch(failStorage));

  const readRows = sql<PeerLinkRow>`
    SELECT * FROM peer_environment_links ORDER BY label, environment_id
  `.pipe(Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerLinkRow>`
      SELECT * FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  /** Signs in to the peer's `/mcp` with a pairing code: register, decide, exchange. */
  const signIn = Effect.fn("PeerLinks.signIn")(
    function* (
      origin: string,
      input: PeerLinkCreateInput,
      self: { readonly environmentId: EnvironmentId; readonly label: string },
    ) {
      const client = yield* clientFor(origin);
      // Only the peer's own refusals are rejections. A dropped connection or
      // an answer this version cannot read is classified below.
      const registered = yield* client.mcpOAuth
        .register({
          payload: {
            client_name: `T3.CodeShip · ${self.label}`,
            redirect_uris: [LINK_REDIRECT_URI],
            software_id: MCP_PEER_LINK_SOFTWARE_ID,
            peer_environment_id: self.environmentId,
          },
        })
        .pipe(
          // A plain Schema.Error has no tag to catch by.
          Effect.catchIf(Schema.is(AuthMcpRegistrationError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused to register this environment: ${error.message}`,
              }),
            ),
          ),
        );
      const verifier = Base64Url.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
      const challenge = Base64Url.encode(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      );
      const state = Base64Url.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie));
      const resource = `${origin}/mcp`;
      const decided = yield* client.mcpOAuth
        .decision({
          payload: {
            authorization: {
              response_type: "code",
              client_id: registered.client_id,
              redirect_uri: LINK_REDIRECT_URI,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state: Redacted.make(state),
              resource,
            },
            decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
          },
        })
        .pipe(
          Effect.catchTags({
            AuthMcpApprovalError: (error) =>
              Effect.fail(
                new PeerLinkError({ reason: "pairing_rejected", message: error.message }),
              ),
          }),
        );
      const redirect = URL.parse(decided.redirectTo);
      if (redirect === null) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${origin} answered the sign-in with an address this version cannot read. Update both environments.`,
        });
      }
      const code = redirect.searchParams.get("code");
      if (code === null || redirect.searchParams.get("state") !== state) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            redirect.searchParams.get("error_description") ??
            "The peer did not approve the link. Check the pairing code and try again.",
        });
      }
      return yield* client.mcpOAuth
        .token({
          payload: {
            grant_type: "authorization_code",
            code: Redacted.make(code),
            redirect_uri: LINK_REDIRECT_URI,
            client_id: registered.client_id,
            code_verifier: Redacted.make(verifier),
            resource,
          },
        })
        .pipe(
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused the sign-in: ${error.message}`,
              }),
            ),
          ),
        );
    },
    (effect, origin) =>
      effect.pipe(
        // Endpoint errors are mapped above; what is left is the transport or an
        // answer this version cannot decode.
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "incompatible",
                message: `${origin} answered in a shape this version does not understand. Update both environments.`,
                cause,
              }),
            ),
          HttpClientError: (cause) =>
            Effect.fail(
              new PeerLinkError({
                reason: "unreachable",
                message: `${origin} stopped answering while linking.`,
                cause,
              }),
            ),
        }),
      ),
  );

  /**
   * The addresses that answer as `environmentId`, in the order given, with
   * what the first one answered. Addresses this environment would not send
   * credentials to are skipped; when every one is, the failure says why.
   */
  const answeringAs = Effect.fn("PeerLinks.answeringAs")(function* (
    urls: ReadonlyArray<string>,
    environmentId: EnvironmentId,
    name: string,
  ) {
    const checked = yield* Effect.forEach(
      urls,
      (url) =>
        Effect.gen(function* () {
          const origin = yield* peerOrigin(url);
          return { origin, descriptor: yield* describe(origin) };
        }).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const matching = checked.flatMap((result) =>
      Result.isSuccess(result) &&
      Option.isSome(result.success.descriptor) &&
      result.success.descriptor.value.environmentId === environmentId
        ? [{ origin: result.success.origin, descriptor: result.success.descriptor.value }]
        : [],
    );
    const first = matching[0];
    if (first === undefined) {
      const refusals = checked.flatMap((result) =>
        Result.isFailure(result) ? [result.failure.message] : [],
      );
      return yield* new PeerLinkError({
        reason: "unreachable",
        message:
          refusals.length === checked.length
            ? `This environment could not reach ${name}: ${refusals.join(" ")}`
            : `This environment could not reach ${name} at ${urls.join(", ")}.`,
      });
    }
    // Each address is kept once, even when two spellings share an origin.
    const origins = [...new Set(matching.map((found) => found.origin))];
    return { primary: first.origin, peer: first.descriptor, origins };
  });

  /** The peer at `url`, with every address checked for credentials first. */
  const answeringAt = Effect.fn("PeerLinks.answeringAt")(function* (urls: ReadonlyArray<string>) {
    const origins = yield* Effect.forEach(urls, peerOrigin);
    const primary = origins[0]!;
    const descriptor = yield* describe(primary);
    if (Option.isNone(descriptor)) {
      return yield* new PeerLinkError({
        reason: "not_a_t3_environment",
        message: `Nothing at ${primary} answered as a T3.CodeShip environment.`,
      });
    }
    return { primary, peer: descriptor.value, origins };
  });

  const alreadyLinked = (label: string) =>
    new PeerLinkError({
      reason: "already_linked",
      message: `This environment already has a link to ${label}. Unlink it here first to link it again.`,
    });

  const link: PeerLinks["Service"]["link"] = Effect.fn("PeerLinks.link")(function* (input, opts) {
    const onlyNew = opts?.onlyNew === true;
    if (!(yield* enabled)) {
      return yield* new PeerLinkError({ reason: "disabled", message: LINKED_ENVIRONMENTS_OFF });
    }
    const urls = [input.url, ...(input.alternateUrls ?? [])];
    // The user picked a machine: link through the addresses that prove to
    // be it, so a reused LAN address never receives the pairing code.
    const { primary, peer, origins } =
      input.expectedEnvironmentId === undefined
        ? yield* answeringAt(urls)
        : yield* answeringAs(
            urls,
            input.expectedEnvironmentId,
            input.expectedLabel ?? input.expectedEnvironmentId,
          );
    const self = yield* environment.getDescriptor;
    if (peer.environmentId === self.environmentId) {
      return yield* new PeerLinkError({
        reason: "self",
        message: "That address is this environment.",
      });
    }
    if (!linkLimitsHold(peer)) {
      return yield* new PeerLinkError({
        reason: "incompatible",
        message: `${peer.label} runs a T3.CodeShip version that cannot keep a linked agent's limits. Update it, then link again.`,
      });
    }
    // Checked before any code is sent, and again by the insert below for a link made meanwhile.
    if (onlyNew && Option.isSome(yield* readRow(peer.environmentId))) {
      return yield* alreadyLinked(peer.label);
    }
    const issued = yield* signIn(primary, input, self);
    const now = yield* DateTime.now;
    const linked: PeerLink = {
      environmentId: peer.environmentId,
      label: peer.label,
      urls: origins,
      access: input.access,
      linkedAt: now,
      expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
      lastReachedAt: now,
      lastError: null,
    };
    // The token goes under a name of its own before the row points at it,
    // so the row and its token are replaced together.
    const secretName = yield* newSecretName;
    yield* secrets
      .set(secretName, new TextEncoder().encode(issued.access_token))
      .pipe(Effect.catch(failStorage));
    // A token no row names could never be removed.
    const previous = yield* Effect.gen(function* () {
      const urlsJson = yield* encodeUrls(origins).pipe(Effect.catch(failStorage));
      if (onlyNew) {
        const inserted = yield* sql<{ readonly environment_id: string }>`
          INSERT INTO peer_environment_links (
            environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
            last_reached_at, last_error, fenced
          ) VALUES (
            ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
            ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
            ${DateTime.formatIso(now)}, NULL, 1
          )
          ON CONFLICT (environment_id) DO NOTHING
          RETURNING environment_id
        `.pipe(Effect.catch(failStorage));
        if (inserted.length === 0) return yield* alreadyLinked(peer.label);
        return Option.none<PeerLinkRow>();
      }
      const previous = yield* readRow(peer.environmentId);
      yield* sql`
        INSERT INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
          last_reached_at, last_error, fenced
        ) VALUES (
          ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
          ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
          ${DateTime.formatIso(now)}, NULL, 1
        )
        ON CONFLICT (environment_id) DO UPDATE SET
          secret_name = excluded.secret_name,
          fenced = excluded.fenced,
          label = excluded.label,
          urls_json = excluded.urls_json,
          access = excluded.access,
          linked_at = excluded.linked_at,
          expires_at = excluded.expires_at,
          last_reached_at = excluded.last_reached_at,
          last_error = NULL
      `.pipe(Effect.catch(failStorage));
      return previous;
    }).pipe(Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)));
    // Linking again replaces the old token. A racing link may leave its own
    // behind; it is unused either way.
    if (Option.isSome(previous) && previous.value.secret_name !== secretName) {
      yield* secrets.remove(previous.value.secret_name).pipe(Effect.ignore);
    }
    return linked;
  });

  const describeUrl: PeerLinks["Service"]["describe"] = (url) =>
    peerOrigin(url).pipe(
      Effect.flatMap(describe),
      Effect.map(Option.map((peer) => ({ environmentId: peer.environmentId, label: peer.label }))),
      Effect.orElseSucceed(() => Option.none()),
    );

  const statusOf = (link: PeerLink, now: DateTime.Utc) =>
    DateTime.isLessThanOrEqualTo(link.expiresAt, now)
      ? Effect.succeed<PeerLinkStatus>("expired")
      : Effect.findFirst(link.urls, (url) =>
          describe(url).pipe(
            Effect.map(
              (found) => Option.isSome(found) && found.value.environmentId === link.environmentId,
            ),
          ),
        ).pipe(
          Effect.map((answered): PeerLinkStatus =>
            Option.isSome(answered) ? "reachable" : "unreachable",
          ),
        );

  const list: PeerLinks["Service"]["list"] = Effect.gen(function* () {
    const links = yield* Effect.forEach(yield* readRows, toLink);
    const now = yield* DateTime.now;
    return yield* Effect.forEach(
      links,
      (link) => statusOf(link, now).pipe(Effect.map((status) => ({ ...link, status }))),
      { concurrency: "unbounded" },
    );
  });

  const listStored: PeerLinks["Service"]["listStored"] = readRows.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, toLink)),
  );

  const get: PeerLinks["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toLink(row)),
        }),
      ),
    );

  const unlink: PeerLinks["Service"]["unlink"] = Effect.fn("PeerLinks.unlink")(
    function* (environmentId) {
      const deleted = yield* sql<{ secret_name: string }>`
        DELETE FROM peer_environment_links WHERE environment_id = ${environmentId}
        RETURNING secret_name
      `.pipe(Effect.catch(failStorage));
      for (const row of deleted) {
        yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
      }
      return deleted.length > 0;
    },
  );

  const resolve: PeerLinks["Service"]["resolve"] = Effect.fn("PeerLinks.resolve")(
    function* (environmentId) {
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) {
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `This environment is not linked to ${environmentId}. t3_environment_links lists the linked ones.`,
        });
      }
      const link = yield* toLink(row.value);
      if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
        return yield* new PeerLinkError({
          reason: "expired",
          message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
        });
      }
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      if (Option.isNone(stored)) {
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `The link to ${link.label} lost its credential. Link it again.`,
        });
      }
      // The token goes only to an address that proves it is this peer, so a
      // reused LAN address or a moved hostname never receives it.
      let fenced = true;
      let serverVersion = "";
      const url = yield* Effect.findFirst(link.urls, (candidate) =>
        describe(candidate).pipe(
          Effect.map((found) => {
            if (Option.isNone(found) || found.value.environmentId !== environmentId) return false;
            fenced = linkLimitsHold(found.value);
            serverVersion = found.value.serverVersion;
            return true;
          }),
        ),
      );
      if (Option.isNone(url)) {
        return yield* new PeerLinkError({
          reason: "unreachable",
          message: `${link.label} did not answer at ${link.urls.join(", ")}.`,
        });
      }
      // A link made before the peer had to fence linked work, or a peer moved
      // back to such a version, would carry work past those limits.
      if (!fenced) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} runs a T3.CodeShip version that cannot keep a linked agent's limits. Update it, then link again.`,
        });
      }
      return {
        link,
        url: url.value,
        token: new TextDecoder().decode(stored.value),
        serverVersion,
      };
    },
  );

  const recordOutcome: PeerLinks["Service"]["recordOutcome"] = (environmentId, outcome) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        outcome.error === null
          ? sql`
              UPDATE peer_environment_links
              SET last_reached_at = ${DateTime.formatIso(now)}, last_error = NULL
              WHERE environment_id = ${environmentId}
            `
          : sql`
              UPDATE peer_environment_links SET last_error = ${outcome.error}
              WHERE environment_id = ${environmentId}
            `,
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  const renew: PeerLinks["Service"]["renew"] = Effect.fn("PeerLinks.renew")(
    function* (environmentId) {
      if (!(yield* enabled)) return;
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) return;
      const link = yield* toLink(row.value);
      const now = yield* DateTime.now;
      if (
        DateTime.isLessThanOrEqualTo(link.expiresAt, now) ||
        DateTime.isGreaterThan(link.expiresAt, DateTime.add(now, { days: 10 }))
      )
        return;
      const { primary, peer } = yield* answeringAs(link.urls, environmentId, link.label);
      if (!linkLimitsHold(peer)) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} cannot keep a linked agent's limits. Update it, then link again.`,
        });
      }
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      if (Option.isNone(stored)) return;
      const client = yield* clientFor(primary);
      const issued = yield* client.mcpOAuth
        .token({
          payload: {
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: Redacted.make(new TextDecoder().decode(stored.value)),
            subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
            resource: `${primary}/mcp`,
          },
        })
        .pipe(
          Effect.timeout(probeTimeout(primary)),
          Effect.asSome,
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.gen(function* () {
              if (error.error === "unsupported_grant_type") {
                yield* sql`
            UPDATE peer_environment_links
            SET last_error = ${`Update ${link.label} so this link can renew itself.`}
            WHERE environment_id = ${environmentId} AND secret_name = ${row.value.secret_name}
          `.pipe(Effect.catch(failStorage));
              }
              return Option.none();
            }),
          ),
          Effect.mapError(
            () =>
              new PeerLinkError({
                reason: "unreachable",
                message: `${link.label} did not answer the link renewal.`,
              }),
          ),
        );
      if (Option.isNone(issued)) return;
      if (!Number.isFinite(issued.value.expires_in) || issued.value.expires_in <= 0) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} returned an invalid link expiry.`,
        });
      }
      const expiresAt = DateTime.add(now, { seconds: issued.value.expires_in });
      if (!DateTime.isGreaterThan(expiresAt, link.expiresAt)) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} returned an invalid link expiry.`,
        });
      }
      yield* Effect.gen(function* () {
        const secretName = yield* newSecretName;
        yield* secrets
          .set(secretName, new TextEncoder().encode(issued.value.access_token))
          .pipe(Effect.catch(failStorage));
        const updated = yield* sql<{ environment_id: string }>`
        UPDATE peer_environment_links SET
          secret_name = ${secretName}, expires_at = ${DateTime.formatIso(expiresAt)}, last_error = NULL
        WHERE environment_id = ${environmentId} AND secret_name = ${row.value.secret_name}
        RETURNING environment_id
      `.pipe(
          Effect.catch(failStorage),
          Effect.onError(() => secrets.remove(secretName).pipe(Effect.ignore)),
        );
        yield* secrets
          .remove(updated.length > 0 ? row.value.secret_name : secretName)
          .pipe(Effect.catch(failStorage));
      }).pipe(Effect.uninterruptible);
    },
  );

  const renewOnce = Effect.fn("PeerLinks.renewOnce")(
    function* () {
      if (!(yield* enabled)) return;
      yield* Effect.forEach(
        yield* listStored,
        (link) =>
          renew(link.environmentId).pipe(
            Effect.catch((error) =>
              Effect.logDebug("Could not renew a linked environment", {
                environmentId: link.environmentId,
                reason: error.reason,
              }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    },
    Effect.catchCause(() => Effect.logWarning("Could not renew linked environments.")),
  );

  const start = forkParked(
    renewOnce().pipe(Effect.andThen(Effect.sleep(Duration.hours(1))), Effect.forever),
  );

  return PeerLinks.of({
    enabled,
    link,
    renew,
    start,
    describe: describeUrl,
    list,
    listStored,
    get,
    unlink,
    resolve,
    recordOutcome,
  });
});

export const layer = Layer.effect(PeerLinks, make);

export const layerWorker = Layer.effectDiscard(
  PeerLinks.pipe(Effect.flatMap((links) => links.start)),
).pipe(Layer.provide(layer));
