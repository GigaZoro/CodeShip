import { GitCommandError, PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  isLostConnection,
  NON_INTERACTIVE_GIT_ENV,
  remoteFailureText,
} from "../vcs/GitVcsDriverCore.ts";

const NETWORK_TIMEOUT_MS = 60_000;
// UTF-8 holds a character in at most four bytes, so a longer file cannot fit the character limit.
const MAX_FILE_BYTES = PROVIDER_SEND_TURN_MAX_INPUT_CHARS * 4;
const DEFAULT_BRANCH_LINE = /^ref: refs\/heads\/(\S+)\tHEAD$/mu;
const OBJECT_LINE = /^(\S+) (\S+) (\d+)$/u;

export class PromptFileReadError extends Schema.TaggedError<PromptFileReadError>()(
  "PromptFileReadError",
  {
    path: Schema.String,
    /** The branch it was read from, such as `origin/main`; null when that could not be found. */
    ref: Schema.NullOr(Schema.String),
    detail: Schema.String,
    /** Git could not reach the remote or got no answer, so the read can work once the network is back. */
    lostConnection: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Could not read the prompt file ${this.path} from ${this.ref ?? "the remote's default branch"}: ${this.detail}`;
  }
}

export interface PromptFileText {
  readonly text: string;
  /** Such as `origin/main`. */
  readonly ref: string;
  readonly commit: string;
}

const gitDetail = (error: GitCommandError): string => {
  const line = error.detail
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .findLast((part) => part !== "");
  return line ?? error.message;
};

export class PromptFileReader extends Context.Service<
  PromptFileReader,
  {
    /**
     * Fetches the remote's default branch and reads `path` from its tip, so every machine reads
     * what was last pushed. `path` starts at the repository's root.
     */
    readonly read: (input: {
      readonly cwd: string;
      readonly path: string;
    }) => Effect.Effect<PromptFileText, PromptFileReadError>;
  }
>()("t3/scheduledTasks/PromptFileReader") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const crypto = yield* Crypto.Crypto;

  const read: PromptFileReader["Service"]["read"] = Effect.fn("PromptFileReader.read")(function* ({
    cwd,
    path,
  }) {
    const fail = (ref: string | null, detail: string, lostConnection = false) =>
      new PromptFileReadError({ path, ref, detail, lostConnection });
    const run = (ref: string | null, input: Omit<GitVcsDriver.ExecuteGitInput, "cwd" | "env">) =>
      git
        .execute({ ...input, cwd, env: NON_INTERACTIVE_GIT_ENV })
        .pipe(Effect.mapError((error) => fail(ref, gitDetail(error))));
    // The phase that hung, or the line Git failed with, goes into the detail.
    const runRemote = (ref: string | null, operation: string, args: string[], context: string) =>
      git
        .executeRemote({
          operation,
          cwd,
          args,
          timeoutMs: NETWORK_TIMEOUT_MS,
          fallbackErrorDetail: "Git exited with an error.",
        })
        .pipe(
          Effect.mapError((error) =>
            fail(ref, `${context}: ${remoteFailureText(error)}`, isLostConnection(error)),
          ),
        );

    const remote = yield* git
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.mapError((error) => fail(null, gitDetail(error))));
    const head = yield* runRemote(
      null,
      "PromptFileReader.defaultBranch",
      ["ls-remote", "--symref", "--", remote, "HEAD"],
      `could not ask ${remote} for its default branch`,
    );
    const branch = DEFAULT_BRANCH_LINE.exec(head.stdout)?.[1];
    if (branch === undefined) return yield* fail(null, `${remote} does not name a default branch`);
    const ref = `${remote}/${branch}`;

    // A ref of this read's own, so it never races the user's or the status poll's fetches.
    const ownRef = `refs/t3/prompt-files/${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
    yield* Effect.acquireRelease(
      runRemote(
        ref,
        "PromptFileReader.fetch",
        // An empty `--refmap` stops Git from also updating `<remote>/<branch>`.
        // `--no-auto-gc`: see GitVcsDriverCore's status fetch for why a poll never starts gc.
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-auto-gc",
          "--refmap=",
          "--",
          remote,
          `+refs/heads/${branch}:${ownRef}`,
        ],
        "could not fetch it",
      ),
      () =>
        git
          .execute({
            operation: "PromptFileReader.dropRef",
            cwd,
            args: ["update-ref", "-d", ownRef],
          })
          .pipe(Effect.ignore({ log: true })),
    );
    const commit = (yield* run(ref, {
      operation: "PromptFileReader.commit",
      args: ["rev-parse", "--verify", `${ownRef}^{commit}`],
    })).stdout.trim();

    const [, blobId, kind, sizeText] =
      OBJECT_LINE.exec(
        (yield* run(ref, {
          operation: "PromptFileReader.object",
          args: ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
          stdin: `${commit}:${path}\n`,
        })).stdout.trim(),
      ) ?? [];
    if (blobId === undefined) return yield* fail(ref, "it does not exist there.");
    if (kind !== "blob") {
      return yield* fail(ref, kind === "tree" ? "it is a folder." : "it is not a file.");
    }
    const tooLong = `it is longer than a prompt can be (${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters).`;
    const size = Number(sizeText);
    if (size > MAX_FILE_BYTES) return yield* fail(ref, tooLong);
    const content = (yield* run(ref, {
      operation: "PromptFileReader.content",
      args: ["cat-file", "blob", blobId],
      maxOutputBytes: size + 1,
    })).stdout;
    if (content.includes("\u0000")) return yield* fail(ref, "it is not a text file.");
    // Decoding replaces bytes that are not UTF-8, so the text hashes back to the file only when
    // it holds exactly what the file says.
    const rehashed = (yield* run(ref, {
      operation: "PromptFileReader.verifyText",
      args: ["hash-object", "--stdin"],
      stdin: content,
    })).stdout.trim();
    if (rehashed !== blobId) return yield* fail(ref, "it is not UTF-8 text.");
    const text = content.trim();
    if (text === "") return yield* fail(ref, "it is empty.");
    // Providers trim before they check the length, so the limit applies to the trimmed text.
    if (text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return yield* fail(ref, tooLong);
    return { text, ref, commit } satisfies PromptFileText;
  }, Effect.scoped);

  return PromptFileReader.of({ read });
});

export const layer = Layer.effect(PromptFileReader, make);
