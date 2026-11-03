import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  makeClaudeCredentialStore,
  make as makeClaudeMcpSignIns,
  mergeClaudeMcpSignIns,
} from "./ClaudeMcpSignIns.ts";

const docs = (token: string, expiresAt?: number) => ({
  serverName: "docs",
  serverUrl: "https://docs.example/mcp",
  accessToken: token,
  ...(token === "" ? {} : { refreshToken: `${token}-refresh` }),
  ...(expiresAt === undefined ? {} : { expiresAt }),
});

describe("mergeClaudeMcpSignIns", () => {
  const merge = (
    main: Record<string, unknown>,
    account: Record<string, unknown>,
    options: {
      readonly synced?: ReadonlyArray<string>;
      readonly prefer?: { readonly store: string; readonly serverName: string };
    } = {},
  ) =>
    mergeClaudeMcpSignIns({
      stores: [
        { key: "main", signIns: main },
        { key: "account", signIns: account },
      ],
      synced: new Map(options.synced ? [["account", new Set(options.synced)]] : []),
      prefer: options.prefer,
    });

  it("gives each store the sign-in that is still good", () => {
    const cases = [
      { main: { "docs|1": docs("a", 100) }, account: {}, expected: docs("a", 100) },
      { main: {}, account: { "docs|1": docs("b", 100) }, expected: docs("b", 100) },
      // A refresh on one account replaces the copy whose refresh token it used up.
      {
        main: { "docs|1": docs("a", 100) },
        account: { "docs|1": docs("b", 200) },
        expected: docs("b", 200),
      },
      // Claude blanks a token it cannot refresh; the other account's sign-in still works.
      { main: { "docs|1": docs("", 0) }, account: { "docs|1": docs("b") }, expected: docs("b") },
      { main: { "docs|1": docs("a") }, account: { "docs|1": docs("b") }, expected: docs("a") },
    ];
    for (const { main, account, expected } of cases) {
      assert.deepStrictEqual(merge(main, account), { "docs|1": expected });
    }
  });

  it("removes a server signed out of on any store since the last merge", () => {
    assert.deepStrictEqual(merge({ "docs|1": docs("a") }, {}, { synced: ["docs|1"] }), {});
    assert.deepStrictEqual(merge({}, { "docs|1": docs("b") }, { synced: ["docs|1"] }), {});
  });

  it("keeps a sign-in that just finished over a sign-out and a later token", () => {
    const prefer = { store: "account", serverName: "docs" };
    assert.deepStrictEqual(
      merge({ "docs|1": docs("a", 200) }, { "docs|1": docs("b", 100) }, { prefer }),
      { "docs|1": docs("b", 100) },
    );
    assert.deepStrictEqual(
      merge({}, { "docs|1": docs("b", 100) }, { synced: ["docs|1"], prefer }),
      { "docs|1": docs("b", 100) },
    );
  });
});

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeEffect(Json);

it.layer(NodeServices.layer)("ClaudeMcpSignIns", (it) => {
  it.effect("shares sign-ins between account files without touching their logins", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-" }));
      const homes = {
        main: path.join(root, ".claude"),
        account: path.join(root, "account", "home"),
        signedOut: path.join(root, "signed-out", "home"),
      };
      for (const home of Object.values(homes)) yield* fs.makeDirectory(home, { recursive: true });
      const credentialsPath = (home: string) => path.join(home, ".credentials.json");
      const write = (home: string, value: unknown) =>
        encodeJson(value).pipe(
          Effect.flatMap((text) => fs.writeFileString(credentialsPath(home), text)),
        );
      const read = (home: string) =>
        fs.readFileString(credentialsPath(home)).pipe(Effect.flatMap(decodeJson));
      yield* write(homes.main, {
        claudeAiOauth: { accessToken: "main-login" },
        mcpOAuth: { "docs|1": docs("a", 100) },
      });
      yield* write(homes.account, { claudeAiOauth: { accessToken: "account-login" } });

      const signIns = yield* makeClaudeMcpSignIns;
      const store = (home: string) => makeClaudeCredentialStore({ CLAUDE_CONFIG_DIR: home });
      const main = yield* store(homes.main);
      yield* signIns.join(main, yield* store(homes.account));
      yield* signIns.join(main, yield* store(homes.signedOut));

      yield* signIns.share(main);
      assert.deepStrictEqual(yield* read(homes.account), {
        claudeAiOauth: { accessToken: "account-login" },
        mcpOAuth: { "docs|1": docs("a", 100) },
      });
      // An account that is not signed in to Claude gets no credentials file.
      assert.isFalse(yield* fs.exists(credentialsPath(homes.signedOut)));

      yield* write(homes.account, {
        claudeAiOauth: { accessToken: "account-login" },
        mcpOAuth: {},
      });
      yield* signIns.share(main);
      assert.deepStrictEqual(yield* read(homes.main), {
        claudeAiOauth: { accessToken: "main-login" },
        mcpOAuth: {},
      });
    }).pipe(Effect.provideService(HostProcess.Platform, "linux"), Effect.scoped),
  );
});
