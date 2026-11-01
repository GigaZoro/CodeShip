import {
  ProviderSetupError,
  type ProviderAuthMethod,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";

const TRANSCRIPT_LIMIT = 16_384;

const LOGIN_METHOD: ProviderAuthMethod = {
  id: "login",
  name: "Claude account",
  description: "Signs in with `claude auth login`.",
  type: "terminal",
};

/** Signs a Claude config folder in and out with the CLI's own login, which also reports the account's email and plan. */
export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  /** Carries `CLAUDE_CONFIG_DIR` for an added account's own folder. */
  readonly environment: NodeJS.ProcessEnv;
  readonly configDir: string;
  /** Links the shared Claude files into the account's folder before Claude writes to it. */
  readonly prepare: Effect.Effect<void>;
  readonly canLogout: boolean;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  /** Runs `claude auth <command>` in a terminal and resolves with its exit code. */
  const runAuthCommand = Effect.fn("ClaudeAuth.runAuthCommand")(function* (
    command: "login" | "logout",
    onOutput: (data: string) => void,
  ) {
    if (Option.isNone(pty))
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    yield* options.prepare;
    const executable = yield* resolveClaudeSdkExecutablePath(
      options.binaryPath,
      options.environment,
    );
    // Older npm installs resolve to a script entry that the SDK also runs with node.
    const launch = executable.endsWith(".js")
      ? { shell: "node", args: [executable, "auth", command] }
      : { shell: executable, args: ["auth", command] };
    const exited = yield* Deferred.make<number>();
    const process = yield* pty.value
      .spawn({ ...launch, cwd: options.cwd, cols: 80, rows: 24, env: options.environment })
      .pipe(Effect.mapError((cause) => failure("start", "Could not start Claude sign-in.", cause)));
    const detachData = process.onData(onOutput);
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {}
      }),
    );
    return { process, exitCode: Deferred.await(exited) };
  });

  const authenticate = Effect.fn("ClaudeAuth.authenticate")(function* (
    _methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const output = yield* Queue.sliding<string>(64);
    const { process, exitCode } = yield* runAuthCommand("login", (data) => {
      Queue.offerUnsafe(output, data.slice(-TRANSCRIPT_LIMIT));
    });
    let transcript = "";
    let outputOffset = 0;
    const update = (): Effect.Effect<void> =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type !== "terminal"
            ? Effect.void
            : Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () =>
                  failure("respond", "The Claude sign-in terminal is no longer available."),
              }),
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-TRANSCRIPT_LIMIT);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* exitCode) !== 0)
      return yield* failure("start", "Claude sign-in did not finish. Start sign-in again.");
    yield* context.verifying;
  });

  const logout = Effect.scoped(
    Effect.gen(function* () {
      const { exitCode } = yield* runAuthCommand("logout", () => {});
      if ((yield* exitCode) !== 0)
        return yield* failure("logout", "Claude could not sign this account out. Try again.");
      return "Signed this Claude account out.";
    }),
  );

  // Claude uses this token ahead of its saved login, so a sign-in would not change the account.
  const usesToken = Boolean(options.environment.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  const canAuthenticate = Option.isSome(pty) && !usesToken;
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // The Claude CLI owns the login, and every instance on this folder shares it.
    credentialBinding: { owner: "provider", key: `claude:home:${options.configDir}` },
    methods: usesToken
      ? failure(
          "start",
          "This provider uses CLAUDE_CODE_OAUTH_TOKEN instead of a sign-in. Remove the token to sign in.",
        )
      : Effect.succeed(canAuthenticate ? [LOGIN_METHOD] : []),
    authenticate,
    logout: options.canLogout
      ? logout
      : failure("logout", "Sign out of the Claude CLI's own login in a terminal."),
  });
  return { controller, canAuthenticate };
});
