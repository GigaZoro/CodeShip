import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class ReleaseIndexError extends Schema.TaggedError<ReleaseIndexError>()(
  "ReleaseIndexError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    published_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeReleaseIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseIndex));

const RELEASE_INDEX_TIMEOUT = Duration.seconds(30);
const RELEASE_INDEX_MAX_PAGES = 10;

const readReleasePage = Effect.fn("cloud.release_index.read_page")(function* (page: number) {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const githubToken = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  const request = HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
    HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
  );
  const authenticatedRequest =
    githubToken === undefined
      ? request
      : HttpClientRequest.setHeader(request, "Authorization", `Bearer ${githubToken}`);
  const body = yield* httpClient.execute(authenticatedRequest).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError(() => new ReleaseIndexError({ reason: "Could not list t3 releases." })),
    Effect.timeoutOrElse({
      duration: RELEASE_INDEX_TIMEOUT,
      orElse: () =>
        Effect.fail(new ReleaseIndexError({ reason: "Timed out listing t3 releases." })),
    }),
  );
  return yield* decodeReleaseIndex(body).pipe(
    Effect.mapError(
      () => new ReleaseIndexError({ reason: "The t3 release index had an unexpected shape." }),
    ),
  );
});

export interface PublishedRelease {
  readonly version: string;
  readonly publishedAtMillis: number | undefined;
}

export const publishedReleases = (channel: CliReleaseChannel) =>
  Stream.paginate(1, (page) =>
    readReleasePage(page).pipe(
      Effect.map(
        (releases) =>
          [
            releases.flatMap((release): ReadonlyArray<PublishedRelease> => {
              const version = newestCliReleaseVersion([release], channel);
              if (version === undefined) return [];
              const publishedAtMillis = Date.parse(release.published_at ?? "");
              return [
                {
                  version,
                  publishedAtMillis: Number.isFinite(publishedAtMillis)
                    ? publishedAtMillis
                    : undefined,
                },
              ];
            }),
            releases.length === 0 || page >= RELEASE_INDEX_MAX_PAGES
              ? Option.none()
              : Option.some(page + 1),
          ] as const,
      ),
    ),
  );

/** The newest published release of this build's repository on `channel`, from GitHub's index. */
export const resolveNewestVersion = Effect.fn("cloud.release_index.resolve_newest")(function* (
  channel: CliReleaseChannel,
) {
  const newest = yield* Stream.runHead(publishedReleases(channel));
  if (Option.isSome(newest)) return newest.value.version;
  return yield* new ReleaseIndexError({ reason: `No published ${channel} release was found.` });
});
