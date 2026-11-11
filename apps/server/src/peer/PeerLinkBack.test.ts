import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  OrchestratorMcpFailure,
  OrchestratorMcpLinkBackResult,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { assertMayLinkBack } from "../mcp/linkOrigin.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SharedSettings from "../sharedSettings/SharedSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinkBack from "./PeerLinkBack.ts";
import * as PeerLinkRequests from "./PeerLinkRequests.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, linkTo, servePeer } from "./PeerLinks.testkit.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";

// Linking both ways: Laptop links Box and asks it to link back over the new link, with a code
// Laptop made itself. Both machines run real linking, OAuth and `/mcp`; only Box's threads and
// projects are mocks, since linking back touches neither.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const desk = descriptorOf("environment-desk", "Desk");

const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;

type LinkingContext = Context.Context<
  PeerLinks.PeerLinks | PeerMcpClient.PeerMcpClient | ServerEnvironment.ServerEnvironment
>;

/** What a machine's linking and signing in need from its own environment. */
const layerBack = <E, R>(
  linking: LinkingContext,
  auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth, E, R>,
  addresses: ReadonlyArray<string>,
) =>
  PeerLinkBack.layer.pipe(
    Layer.provide(Layer.succeedContext(linking)),
    Layer.provide(auth),
    Layer.provide(
      Layer.succeed(DirectEndpoints.DirectEndpoints, {
        resolve: Effect.fn("test.directEndpoints")(() =>
          Effect.succeed(
            addresses.map((httpBaseUrl) => ({ kind: "tailnet" as const, httpBaseUrl })),
          ),
        ),
      }),
    ),
  );

/** Box's `/mcp`: its real orchestrator tools, answering `t3_link_back` with Box's own links. */
const serveBox = (boxLinking: LinkingContext) =>
  servePeer(
    box,
    McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provide(NodeCrypto.layer),
      Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
      Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-back-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
          Layer.mock(SharedSettings.SharedSettings)({}),
          // Box answers with its own links; only the code it is given reaches anything.
          layerBack(boxLinking, Layer.mock(EnvironmentAuth.EnvironmentAuth)({}), []),
        ),
      ),
      Layer.provide(Layer.succeedContext(boxLinking)),
    ),
  );

/** Laptop: reachable by Box, minting its own pairing codes, and recording each. */
const makeLaptop = Effect.gen(function* () {
  const served = yield* servePeer(laptop, Layer.empty);
  const linking = yield* layerLinkingEnvironment(laptop).pipe(Layer.build);
  const minted = yield* Ref.make<
    ReadonlyArray<{ readonly id: string; readonly credential: string }>
  >([]);
  const auth = EnvironmentAuth.EnvironmentAuth.of({
    ...served.auth,
    createPairingLink: (input) =>
      served.auth
        .createPairingLink(input)
        .pipe(
          Effect.tap((issued) =>
            Ref.update(minted, (all) => [...all, { id: issued.id, credential: issued.credential }]),
          ),
        ),
  });
  const back = yield* Layer.build(
    layerBack(linking, Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth), [served.url]),
  );
  return {
    served,
    minted,
    links: Context.get(linking, PeerLinks.PeerLinks),
    peer: Context.get(linking, PeerMcpClient.PeerMcpClient),
    back: Context.get(back, PeerLinkBack.PeerLinkBack),
  };
});

/** Box: its own links, reached at its `/mcp` as `served`. */
const makeBox = Effect.gen(function* () {
  const linking = yield* layerLinkingEnvironment(box).pipe(Layer.build);
  const served = yield* serveBox(linking);
  return {
    served,
    links: Context.get(linking, PeerLinks.PeerLinks),
    settings: Context.get(linking, ServerSettings.ServerSettingsService),
  };
});

const linkBoth = (
  l: Effect.Success<typeof makeLaptop>,
  b: Effect.Success<typeof makeBox>,
  access: AuthMcpClientAccess,
  reverse: AuthMcpClientAccess,
) =>
  b.served.auth.issuePairingCredential().pipe(
    Effect.flatMap((pairing) =>
      l.back.link({
        url: b.served.url,
        pairingCode: pairing.credential,
        access,
        expectedEnvironmentId: box.environmentId,
        reverse: { access: reverse },
      }),
    ),
  );

const withLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    const logger = Logger.make(({ message, cause }) => {
      lines.push(JSON.stringify(message), JSON.stringify(cause));
    });
    const result = yield* effect.pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
    return { result, logs: lines.join("\n") };
  });

it.effect("links both ways in one step, with the access chosen for the other machine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const l = yield* makeLaptop;
      const b = yield* makeBox;
      const { result: linked, logs } = yield* withLogs(linkBoth(l, b, "full-access", "auto"));

      expect(linked.access).toBe("full-access");
      expect(linked.back).toEqual({ status: "linked", access: "auto" });
      // Box now holds a link to Laptop with the access Laptop chose, and Laptop's session for it
      // is the one Box's agents act through.
      const reverse = Option.getOrThrow(yield* b.links.get(laptop.environmentId));
      expect(reverse.access).toBe("auto");
      expect(reverse.label).toBe("Laptop");
      expect((yield* l.served.linkedSessions).map((session) => session.client.label)).toEqual([
        "T3.CodeShip · Box",
      ]);

      // One code was made for it, and it is spent: it carries nothing anyone can reuse, and it
      // never reached a result or a log.
      const [code] = yield* Ref.get(l.minted);
      expect(logs).not.toContain(code!.credential);
      expect(JSON.stringify(linked)).not.toContain(code!.credential);
      const reused = yield* l.served.auth
        .consumeMcpApprovalCode(code!.credential, "auto")
        .pipe(Effect.result);
      expect(Result.isFailure(reused)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("does not ask Box to link back below auto access, and makes no code", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const l = yield* makeLaptop;
      const b = yield* makeBox;
      const linked = yield* linkBoth(l, b, "approval-required", "approval-required");

      expect(linked.access).toBe("approval-required");
      expect(linked.back?.status).toBe("not_linked");
      expect(yield* Ref.get(l.minted)).toEqual([]);
      expect(yield* b.links.get(laptop.environmentId)).toEqual(Option.none());
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("still names where it signed in from after the link renews", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const l = yield* makeLaptop;
      const b = yield* makeBox;
      const pairing = yield* b.served.auth.issuePairingCredential();
      yield* l.links.link({ url: b.served.url, pairingCode: pairing.credential, access: "auto" });
      yield* TestClock.adjust(Duration.days(21));
      yield* l.links.renew(box.environmentId);
      const code = yield* l.served.auth.issuePairingCredential();

      const linked = yield* l.peer.call({
        environmentId: box.environmentId,
        tool: "t3_link_back",
        arguments: {
          environmentId: laptop.environmentId,
          urls: [l.served.url],
          pairingCode: code.credential,
          access: "auto",
        },
        limits,
        success: OrchestratorMcpLinkBackResult,
      });

      expect(linked).toEqual({
        environmentId: laptop.environmentId,
        label: "Laptop",
        access: "auto",
      });
      expect(Option.isSome(yield* b.links.get(laptop.environmentId))).toBe(true);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a link that signed in from another environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const l = yield* makeLaptop;
      const b = yield* makeBox;
      // Desk is linked to Box with full access, but it is not Laptop.
      const deskLinking = yield* layerLinkingEnvironment(desk).pipe(Layer.build);
      yield* linkTo(Context.get(deskLinking, PeerLinks.PeerLinks), b.served, "full-access");
      const code = yield* l.served.auth.issuePairingCredential();

      const refused = yield* Context.get(deskLinking, PeerMcpClient.PeerMcpClient)
        .call({
          environmentId: box.environmentId,
          tool: "t3_link_back",
          arguments: {
            environmentId: laptop.environmentId,
            urls: [l.served.url],
            pairingCode: code.credential,
            access: "full-access",
          },
          limits,
          success: OrchestratorMcpLinkBackResult,
        })
        .pipe(Effect.flip);

      expect(refused).toBeInstanceOf(OrchestratorMcpFailure);
      expect(refused.code).toBe("capability_denied");
      expect(yield* b.links.get(laptop.environmentId)).toEqual(Option.none());
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("keeps the link made here when Box is an older version without link back", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const l = yield* makeLaptop;
      const oldBox = yield* servePeer(box, Layer.empty);
      const pairing = yield* oldBox.auth.issuePairingCredential();
      const { result: linked, logs } = yield* withLogs(
        l.back.link({
          url: oldBox.url,
          pairingCode: pairing.credential,
          access: "full-access",
          reverse: { access: "auto" },
        }),
      );

      expect(Option.isSome(yield* l.links.get(box.environmentId))).toBe(true);
      expect(linked.back?.status).toBe("not_linked");
      // The code nobody redeemed no longer works, and was never shown.
      const [code] = yield* Ref.get(l.minted);
      const unused = yield* l.served.auth
        .consumeMcpApprovalCode(code!.credential, "auto")
        .pipe(Effect.result);
      expect(Result.isFailure(unused)).toBe(true);
      expect(logs).not.toContain(code!.credential);
      expect(JSON.stringify(linked)).not.toContain(code!.credential);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("reports that Box has Linked environments off and keeps the link made here", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const l = yield* makeLaptop;
      const b = yield* makeBox;
      // Box's own links check this when it signs in to Laptop; its `/mcp` stays on.
      const pairing = yield* b.served.auth.issuePairingCredential();
      const forward = yield* l.links.link({
        url: b.served.url,
        pairingCode: pairing.credential,
        access: "auto",
      });
      yield* b.settings.updateSettings({ linkedEnvironmentsEnabled: false });
      const back = yield* l.back
        .link({
          url: b.served.url,
          pairingCode: (yield* b.served.auth.issuePairingCredential()).credential,
          access: "auto",
          reverse: { access: "auto" },
        })
        .pipe(Effect.map((linked) => linked.back));

      expect(forward.access).toBe("auto");
      expect(back?.status).toBe("not_linked");
      expect(back?.status === "not_linked" ? back.message : "").toContain(
        "Linked environments is off",
      );
      expect(yield* b.links.get(laptop.environmentId)).toEqual(Option.none());
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const scopeOf = (
  client: McpInvocationContext.McpClientCaller | undefined,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: box.environmentId,
  requestNamespace: "client:test",
  thread: undefined,
  client,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const linkedClient = (
  overrides: Partial<McpInvocationContext.McpClientCaller> = {},
): McpInvocationContext.McpClientCaller => ({
  sessionId: "session",
  label: "T3.CodeShip · Laptop",
  access: "auto",
  linked: true,
  linkedFrom: laptop.environmentId,
  ...overrides,
});

it.effect(
  "allows linking back only to the environment a link signed in from, with auto access",
  () =>
    Effect.gen(function* () {
      const verdict = (scope: McpInvocationContext.McpInvocationScope) =>
        assertMayLinkBack(scope, laptop.environmentId).pipe(
          Effect.match({ onSuccess: () => "allowed", onFailure: (error) => error.message }),
        );

      expect(yield* verdict(scopeOf(linkedClient()))).toBe("allowed");
      expect(yield* verdict(scopeOf(linkedClient({ access: "full-access" })))).toBe("allowed");
      // Not a peer link, such as Claude Code signed in from outside.
      expect(yield* verdict(scopeOf(linkedClient({ linked: false })))).toContain(
        "Only an environment linked",
      );
      expect(yield* verdict(scopeOf(undefined))).toContain("Only an environment linked");
      // Another environment's link, or one made before links named where they came from.
      expect(yield* verdict(scopeOf(linkedClient({ linkedFrom: desk.environmentId })))).toContain(
        "only ask this environment to link back to itself",
      );
      expect(yield* verdict(scopeOf(linkedClient({ linkedFrom: undefined })))).toContain(
        "before linking back was possible",
      );
      // Too little access, whether approved so or narrowed for this call.
      expect(yield* verdict(scopeOf(linkedClient({ access: "auto-accept-edits" })))).toContain(
        "less than auto access",
      );
      expect(yield* verdict(scopeOf(linkedClient({ access: "read-only" })))).toContain(
        "less than auto access",
      );
      expect(
        yield* verdict(
          scopeOf(
            linkedClient({
              access: "full-access",
              narrowedTo: { runtimeMode: "approval-required", interactionMode: "default" },
            }),
          ),
        ),
      ).toContain("less than auto access");
    }),
);
