import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MuseSettings } from "../settings.ts";
import { makeMuseSignedOut, museSignedOutMessage } from "./signedOut.ts";
import { makePendingMuseProvider } from "./status.ts";

const ENABLED = Schema.decodeSync(MuseSettings)({ enabled: true });
const authStatus = (signedOut: Effect.Success<ReturnType<typeof makeMuseSignedOut>>) =>
  makePendingMuseProvider(ENABLED).pipe(
    Effect.flatMap((provider) =>
      signedOut.apply({
        ...provider,
        instanceId: ProviderInstanceId.make("muse"),
        driver: ProviderDriverKind.make("muse"),
        installed: true,
      }),
    ),
    Effect.map((provider) => provider.auth.status),
  );

describe("Muse signed-out mark", () => {
  it.effect("keeps a rejection that a process started before it reports a working login", () =>
    Effect.gen(function* () {
      const signedOut = yield* makeMuseSignedOut("rejected");
      const older = yield* signedOut.launch;
      const newer = yield* signedOut.launch;
      assert.isTrue(yield* newer.rejected);
      assert.isFalse(yield* older.accepted);
      assert.equal(yield* authStatus(signedOut), "unauthenticated");
      const afterLogin = yield* signedOut.launch;
      assert.isTrue(yield* afterLogin.accepted);
      assert.equal(yield* authStatus(signedOut), "unknown");
    }),
  );

  it.effect("signs out when a login stops working after a newer process accepted it", () =>
    Effect.gen(function* () {
      const signedOut = yield* makeMuseSignedOut("rejected");
      const older = yield* signedOut.launch;
      const newer = yield* signedOut.launch;
      assert.isFalse(yield* newer.accepted);
      assert.isTrue(yield* older.rejected);
      assert.equal(yield* authStatus(signedOut), "unauthenticated");
      assert.isFalse(yield* newer.accepted);
      assert.equal(yield* authStatus(signedOut), "unauthenticated");
    }),
  );

  it.each([
    { environment: {}, advice: "`muse login`" },
    { environment: { META_API_KEY: "" }, advice: "`muse login`" },
    { environment: { META_API_KEY: "made-up" }, advice: "META_API_KEY" },
    { environment: { meta_api_key: "made-up" }, advice: "`muse login`" },
  ])("tells how to fix the credential Muse uses ($environment)", ({ environment, advice }) => {
    assert.include(museSignedOutMessage(environment), advice);
  });
});
