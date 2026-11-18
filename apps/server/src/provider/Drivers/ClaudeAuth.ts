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
import * as Scope from "effect/Scope";

import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { CLAUDE_TERMS_REVIEW_MESSAGE } from "./ClaudeHome.ts";
import { ClaudeOAuthTokenOutput } from "../claudeOAuthToken.ts";

const TRANSCRIPT_LIMIT = 16_384;

const DEFAULT_TERMINAL_SIZE = { cols: 80, rows: 24 };

const TERMS_REVIEW_PROMPT =
  "Anthropic updated its Consumer Terms. Claude opens below so this account can review them: answer Claude's prompt, then type /exit to finish signing in.";

const LOGIN_METHOD: ProviderAuthMethod = {
  id: "login",
  name: "Claude account",
  description: "Signs in with `claude auth login`.",
  type: "terminal",
};

const TOKEN_METHOD: ProviderAuthMethod = {
  id: "setup-token",
  name: "One-year token",
  description:
    "Stays signed in for a year with no renewals. Suits accounts that run scheduled tasks. Requires Pro, Max, Ultra, Team or Enterprise. Sessions on this account cannot use Remote Control or claude.ai connectors; MCP servers configured on this machine still work.",
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
  readonly saveToken: (token: string | undefined) => Effect.Effect<void, ProviderSetupError>;
  readonly stageLogin: (
    flowId: string,
    bindingInstances: ReadonlyArray<ProviderInstanceId>,
  ) => Effect.Effect<
    {
      readonly home: string;
      readonly persist: Effect.Effect<void, ProviderSetupError>;
    },
    ProviderSetupError,
    Scope.Scope
  >;
  /** True while Claude refuses to start until this account reviews Anthropic's updated Consumer Terms. */
  readonly needsTermsReview: (home: string) => Effect.Effect<boolean>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });

  /** Runs `claude <args>` in a terminal and resolves with its exit code. */
  const runClaude = Effect.fn("ClaudeAuth.runClaude")(function* (
    args: ReadonlyArray<string>,
    onOutput: (data: string) => void,
    size: { readonly cols: number; readonly rows: number } = DEFAULT_TERMINAL_SIZE,
    loginHome?: string,
  ) {
    if (Option.isNone(pty))
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    if (!loginHome) yield* options.prepare;
    const executable = yield* resolveClaudeSdkExecutablePath(
      options.binaryPath,
      options.environment,
    );
    // Older npm installs resolve to a script entry that the SDK also runs with node.
    const launch = executable.endsWith(".js")
      ? { shell: "node", args: [executable, ...args] }
      : { shell: executable, args: [...args] };
    const exited = yield* Deferred.make<number>();
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...environment } = options.environment;
    const process = yield* PtyAdapter.spawnScoped(
      pty.value,
      {
        ...launch,
        cwd: options.cwd,
        ...size,
        env: loginHome ? { ...environment, CLAUDE_CONFIG_DIR: loginHome } : environment,
      },
      {
        onData: onOutput,
        onExit: ({ exitCode }) => Deferred.doneUnsafe(exited, Effect.succeed(exitCode)),
      },
    ).pipe(Effect.mapError((cause) => failure("start", "Could not start Claude sign-in.", cause)));
    return { process, exitCode: Deferred.await(exited) };
  });

  const authenticate = Effect.fn("ClaudeAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const output = yield* Queue.sliding<string>(64);
    const print = (data: string) => {
      if (data) Queue.offerUnsafe(output, data.slice(-TRANSCRIPT_LIMIT));
    };
    const redactor = new ClaudeOAuthTokenOutput();
    const tokenMethod = methodId === TOKEN_METHOD.id;
    const staged = yield* options
      .stageLogin(context.flowId, context.bindingInstances)
      .pipe(Effect.provideService(Scope.Scope, context.scope));
    // One terminal for the whole sign-in: the terms review reuses it at the size the client last set.
    let size = DEFAULT_TERMINAL_SIZE;
    let current: PtyAdapter.PtyProcess | undefined;
    /** Starts one Claude command in the sign-in terminal; the result waits for its exit code. */
    const startInTerminal = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
      const { process, exitCode } = yield* runClaude(
        args,
        (data) => print(redactor.write(data)),
        tokenMethod ? { ...size, cols: Math.max(size.cols, 4096) } : size,
        staged.home,
      );
      current = process;
      return exitCode;
    });
    const login = yield* startInTerminal(tokenMethod ? ["setup-token"] : ["auth", "login"]);
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
                  if (response.size) {
                    size = response.size;
                    current?.resize(
                      tokenMethod ? Math.max(response.size.cols, 4096) : response.size.cols,
                      response.size.rows,
                    );
                  }
                  if (response.data) current?.write(response.data);
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
    if ((yield* login) !== 0)
      return yield* failure("start", "Claude sign-in did not finish. Start sign-in again.");
    const captured = redactor.finish();
    print(captured.output);
    if (tokenMethod) {
      if (!captured.token)
        return yield* failure(
          "start",
          "Claude did not return a one-year token. Start sign-in again.",
        );
      yield* context.verifying;
      return options.saveToken(captured.token);
    }
    // The terms answer is the account owner's own (it includes whether chats help train models),
    // so the sign-in hands them Claude's prompt instead of answering it for them.
    if (yield* options.needsTermsReview(staged.home)) {
      print(`\r\n\r\n${TERMS_REVIEW_PROMPT}\r\n\r\n`);
      const review = yield* startInTerminal([]);
      yield* review;
      if (yield* options.needsTermsReview(staged.home))
        return yield* failure("start", CLAUDE_TERMS_REVIEW_MESSAGE);
    }
    yield* context.verifying;
    return staged.persist;
  });

  const usesToken = Boolean(options.environment.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  const logout = Effect.scoped(
    Effect.gen(function* () {
      const { exitCode } = yield* runClaude(["auth", "logout"], () => {});
      if ((yield* exitCode) !== 0)
        return yield* failure("logout", "Claude could not sign this account out. Try again.");
      if (usesToken) yield* options.saveToken(undefined);
      return "Signed this Claude account out.";
    }),
  );

  const canAuthenticate = Option.isSome(pty);
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // The Claude CLI owns the login, and every instance on this folder shares it.
    credentialBinding: { owner: "provider", key: `claude:home:${options.configDir}` },
    methods: Effect.succeed(
      canAuthenticate
        ? usesToken
          ? [TOKEN_METHOD, { ...LOGIN_METHOD, name: "Use regular sign-in instead" }]
          : [LOGIN_METHOD, TOKEN_METHOD]
        : [],
    ),
    defaultMethodId: usesToken ? TOKEN_METHOD.id : LOGIN_METHOD.id,
    replacesInstance: true,
    stage: authenticate,
    logout: options.canLogout
      ? logout
      : failure("logout", "Sign out of the Claude CLI's own login in a terminal."),
  });
  return { controller, canAuthenticate };
});
