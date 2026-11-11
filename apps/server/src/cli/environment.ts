import {
  AuthMcpClientAccess,
  AuthStandardClientScopes,
  EnvironmentId,
  PEER_LINK_AGENTS_ONLY_NOTE,
  peerLinkAccessAllowsLinkBack,
  type PeerLinkResult,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinkBack from "../peer/PeerLinkBack.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Links live in this environment's database and secret store, so these
 * commands work whether or not its server is running.
 */
const runWithPeerLinks = Effect.fn("environment.runWithPeerLinks")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (links: PeerLinks.PeerLinks["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* PeerLinks.PeerLinks.pipe(
    Effect.flatMap(run),
    Effect.provide(
      PeerLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerConfig,
            FetchHttpClient.layer,
          ),
        ),
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provide(
          ServerSettings.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSecretStore.layer,
                SqlitePersistence.layerConfig,
                ManagedPolicy.layer,
              ),
            ),
          ),
        ),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

/**
 * Links both ways from a terminal: this environment's own database mints the code the other
 * environment links back with, so no server needs to be running here for the link itself, only
 * for the other environment to redeem the code.
 */
const runLinkingBothWays = Effect.fn("environment.runLinkingBothWays")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (back: PeerLinkBack.PeerLinkBack["Service"]) => Effect.Effect<A, E>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  // The terminal has no network scan: the other environment links back at the addresses given.
  const noDirectEndpoints = Layer.succeed(DirectEndpoints.DirectEndpoints, {
    resolve: Effect.fn("environment.noDirectEndpoints")(() => Effect.succeed([])),
  });
  const peerLinks = PeerLinks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig, FetchHttpClient.layer),
    ),
    Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
    Layer.provide(
      ServerSettings.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerConfig,
            ManagedPolicy.layer,
          ),
        ),
      ),
    ),
  );
  return yield* PeerLinkBack.PeerLinkBack.pipe(
    Effect.flatMap(run),
    Effect.provide(
      PeerLinkBack.layer.pipe(
        Layer.provide(PeerMcpClient.layer.pipe(Layer.provideMerge(peerLinks))),
        Layer.provide(noDirectEndpoints),
        Layer.provide(EnvironmentAuth.layerRuntime),
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeLinks = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(Schema.Unknown))),
);

export const formatLinks = (links: ReadonlyArray<PeerLinkSummary>) =>
  links.length === 0
    ? "No linked environments.\n"
    : `${links
        .map(
          (link) =>
            `${link.label} (${link.environmentId})\n  ${link.status}, access ${link.access}, expires ${DateTime.formatIso(link.expiresAt)}\n  ${link.urls.join(", ")}${link.lastError === null ? "" : `\n  last error: ${link.lastError}`}`,
        )
        .join("\n\n")}\n\n${PEER_LINK_AGENTS_ONLY_NOTE}\n`;

class EnvironmentLinkUsageError extends Schema.TaggedError<EnvironmentLinkUsageError>()(
  "EnvironmentLinkUsageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The access the other environment gets here when none is chosen: below the full access it was given. */
const DEFAULT_REVERSE_ACCESS: AuthMcpClientAccess = "auto";

export const formatLinked = (linked: PeerLinkResult) =>
  `Linked ${linked.label} (${linked.environmentId}) with ${linked.access} access, until ${DateTime.formatIso(linked.expiresAt)}.\n${formatBackOutcome(linked)}${PEER_LINK_AGENTS_ONLY_NOTE}\n`;

const formatBackOutcome = (linked: PeerLinkResult) =>
  linked.back === undefined
    ? ""
    : linked.back.status === "linked"
      ? `${linked.label} linked back with ${linked.back.access} access.\n`
      : `${linked.label} did not link back: ${linked.back.message}\nRun \`t3 environment link\` on ${linked.label} to let it reach this machine.\n`;

const environmentLinkCommand = Command.make("link", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription(
      "Where the other environment answers: its T3 Connect, Tailscale, LAN or loopback address.",
    ),
  ),
  alternateUrl: Flag.String("url").pipe(
    Flag.withDescription("Another address for the same environment, tried after the first."),
    Flag.atLeast(0),
  ),
  pairingCode: Flag.String("pairing-code").pipe(
    Flag.withDescription("A pairing code from the other environment (`t3 pair` there)."),
  ),
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What this environment's agents may do there: read-only, or the broadest runtime mode.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
  bothWays: Flag.Boolean("both-ways").pipe(
    Flag.withDescription(
      "Also let the other environment reach this one: it links back with a pairing code this environment makes, so nothing is typed there. Needs --access full-access, and --own-url.",
    ),
    Flag.withDefault(false),
  ),
  ownUrl: Flag.String("own-url").pipe(
    Flag.withDescription(
      "With --both-ways: an address the other environment reaches this one at (https, Tailscale). Repeat for more.",
    ),
    Flag.atLeast(0),
  ),
  reverseAccess: Flag.Literals("reverse-access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "With --both-ways: what the other environment's agents may do here. Defaults to auto.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Link another T3.CodeShip environment, so agents here can work there. It shows up there under Settings → Connections, where it can be revoked. It is not added to the app's machine list: use Add environment or Linked environments → Add to this app for that.",
  ),
  Command.withHandler(
    Effect.fn("environment.link")(function* (flags) {
      const input = {
        url: flags.url,
        alternateUrls: flags.alternateUrl,
        pairingCode: flags.pairingCode,
        access: flags.access,
      };
      const report = (linked: PeerLinkResult) => Console.log(formatLinked(linked));
      if (!flags.bothWays) {
        return yield* runWithPeerLinks(flags, (links) =>
          links.link(input).pipe(Effect.flatMap(report)),
        );
      }
      if (!peerLinkAccessAllowsLinkBack(flags.access)) {
        return yield* new EnvironmentLinkUsageError({
          detail:
            "--both-ways needs --access full-access: only a full-access link may ask the other environment to link back. Link without it, then link this environment from there.",
        });
      }
      return yield* runLinkingBothWays(flags, (back) =>
        back
          .link(
            {
              ...input,
              reverse: {
                access: Option.getOrElse(flags.reverseAccess, () => DEFAULT_REVERSE_ACCESS),
                urls: flags.ownUrl,
              },
            },
            // Whoever runs this terminal owns this environment's database, and every grant in it.
            { scopes: AuthStandardClientScopes },
          )
          .pipe(Effect.flatMap(report)),
      );
    }),
  ),
);

const environmentListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List linked environments and whether each answers now."),
  Command.withHandler((flags) =>
    runWithPeerLinks(
      flags,
      (links) =>
        Effect.gen(function* () {
          const listed = yield* links.list;
          yield* Console.log(flags.json ? `${yield* encodeLinks(listed)}\n` : formatLinks(listed));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const environmentUnlinkCommand = Command.make("unlink", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `t3 environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Forget a linked environment here. Revoke it in that environment's Connections to end its session there too.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const removed = yield* links.unlink(EnvironmentId.make(flags.environmentId));
        yield* Console.log(
          removed
            ? `Forgot ${flags.environmentId}. Revoke it in that environment's Connections to end its session there.\n`
            : `No linked environment ${flags.environmentId}.\n`,
        );
      }),
    ),
  ),
);

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription("Link other T3.CodeShip environments, so agents here can work there."),
  Command.withSubcommands([
    environmentLinkCommand,
    environmentListCommand,
    environmentUnlinkCommand,
  ]),
);
