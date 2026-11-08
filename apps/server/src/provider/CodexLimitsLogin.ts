import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import {
  readCodexStoredChatGptLogin,
  sameCodexAccountEmail,
  withCodexAppServerClient,
} from "./CodexProvider.ts";
import { codexRateLimitsFailureMessage, codexRateLimitsToLimits } from "./codexUsageLimits.ts";
import { makeCodexChatGptLogin } from "./Drivers/CodexCliAuth.ts";

const READ_TIMEOUT = "20 seconds";

const CODEX_LIMITS_METHOD: ProviderAuthMethod = {
  id: "codex-limits",
  name: "Read usage limits",
  description: "Signs in to Codex's own login, kept only to read this account's limits.",
  type: "agent",
};

export const codexAccountLimitsHomePath = (
  path: Path.Path,
  stateDir: string,
  instanceId: ProviderInstanceId,
) => path.join(stateDir, "providers", "codex", instanceId, "limits");

/**
 * A ChatGPT sharing token cannot read Codex limits, but Codex's own login for the same account can.
 * A ChatGPT-connected account keeps that login in a private Codex home used only for its limits and
 * reset credits, so it never replaces the machine's Codex CLI or Codex Desktop login.
 */
export const makeCodexLimitsLogin = Effect.fn("makeCodexLimitsLogin")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly home: string;
  readonly binaryPath: Effect.Effect<string, ProviderSetupError>;
  readonly environment: NodeJS.ProcessEnv;
  /** The ChatGPT account this instance is connected to. */
  readonly accountEmail: Effect.Effect<string | undefined>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  // Codex refuses a CODEX_HOME that does not exist yet.
  const prepareHome = fileSystem
    .makeDirectory(options.home, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        failure("runtime", "Could not prepare the Codex login for this account's limits.", cause),
      ),
    );
  const openClient = prepareHome.pipe(
    Effect.andThen(options.binaryPath),
    Effect.flatMap((binaryPath) =>
      withCodexAppServerClient({
        binaryPath,
        homePath: options.home,
        cwd: process.cwd(),
        environment: options.environment,
      }),
    ),
    Effect.map(({ client }) => client),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const login = yield* makeCodexChatGptLogin({ instanceId: options.instanceId, openClient });

  /** Reads only the saved file, so a home without a login costs no Codex process. */
  const signedIn = readCodexStoredChatGptLogin(options.home).pipe(
    Effect.map((stored) => stored !== undefined),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const chatGptEmail = (client: Effect.Success<typeof openClient>) =>
    client
      .request("account/read", {})
      .pipe(Effect.map(({ account }) => (account?.type === "chatgpt" ? account.email : undefined)));
  const loginEmail = Effect.scoped(Effect.flatMap(openClient, chatGptEmail));

  /** This account's limits, or undefined while the home has no login, or one of another account. */
  const read: Effect.Effect<ServerProviderUsageLimits | undefined> = Effect.gen(function* () {
    if (!(yield* signedIn)) return undefined;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const probeFailed = (message: string) =>
      makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* openClient;
        const email = yield* chatGptEmail(client);
        if (!sameCodexAccountEmail(email, yield* options.accountEmail)) return undefined;
        return yield* client.request("account/rateLimits/read", null).pipe(
          Effect.map((response) =>
            codexRateLimitsToLimits({
              snapshot: response.rateLimits,
              rateLimitsByLimitId: response.rateLimitsByLimitId,
              resetCredits: response.rateLimitResetCredits,
              checkedAt,
            }),
          ),
          Effect.catch((error) =>
            Effect.succeed(probeFailed(codexRateLimitsFailureMessage(error))),
          ),
        );
      }),
    ).pipe(
      Effect.timeout(READ_TIMEOUT),
      Effect.catch((cause) =>
        Effect.logWarning("Codex could not read limits through its own login.", { cause }).pipe(
          Effect.as(probeFailed("Codex could not be started to read usage.")),
        ),
      ),
    );
  });

  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `codex:limits:${options.home}` },
    methods: Effect.succeed([CODEX_LIMITS_METHOD]),
    authenticate: Effect.fn("CodexLimitsLogin.authenticate")(function* (_methodId, context) {
      yield* login.authenticate(context);
      // The browser may still be signed in to another ChatGPT account.
      const expected = yield* options.accountEmail;
      const email = yield* loginEmail.pipe(
        Effect.mapError((cause) =>
          failure("verify", "Codex could not check which account signed in. Try again.", cause),
        ),
      );
      if (sameCodexAccountEmail(email, expected)) return;
      yield* login.logout;
      return yield* failure(
        "verify",
        expected
          ? `That sign-in was ${email ?? "another account"}. Sign in as ${expected} to read this account's limits.`
          : "Connect this account with ChatGPT before reading its limits.",
      );
    }),
    logout: signedIn.pipe(
      Effect.flatMap((present) =>
        present ? login.logout : Effect.succeed("This account has no limits sign-in."),
      ),
    ),
  });

  return { home: options.home, signedIn, read, openClient, controller };
});
