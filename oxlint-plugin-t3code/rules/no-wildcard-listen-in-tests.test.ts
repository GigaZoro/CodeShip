import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-wildcard-listen-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-wildcard-listen-in-tests", () => {
  rule.valid(
    "allows servers that name their host, socket paths and arguments it cannot tell apart",
    `
      server.listen(0, "127.0.0.1", () => {});
      server.listen(port, host);
      server.listen(0, process.env.CI ? "127.0.0.1" : host);
      server.listen({ port: 0, host: "127.0.0.1" });
      const loopback = { port: 0, host: "127.0.0.1" };
      server.listen(loopback);
      server.listen({ path: socketPath });
      server.listen("/tmp/t3.sock", () => {});
      server.listen(\`\${dir}/t3.sock\`);
      server.listen(socketPath, () => {});
      server.listen(target.address, resolve);
      new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      server.listen({ ...options, port: 0 });
      listen(server, () => {});
      server.listen();
      new WebSocketServer({ host: "127.0.0.1", port: 0 });
      new NodeWS.WebSocketServer({ noServer: true });
      NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 });
      const hostKey = "host";
      server.listen({ port: 0, [hostKey]: "127.0.0.1" });
      server.listen({ port: 0, [addressKey()]: "127.0.0.1" });
      function later() {}
      const first = later;
      const second = first;
      const third = second;
      const fourth = third;
      const fifth = fourth;
      server.listen(0, fifth);
    `,
  );

  rule.invalid(
    "reports servers that listen on every interface",
    `
      server.listen(0);
      server.listen(0, () => {});
      const port = 0;
      server.listen(port, function () {});
      server.listen({ port: 0 });
      const wildcard = { port: 0 };
      server.listen(wildcard);
      new Promise((resolve) => server.listen(0, resolve));
      function ready() {}
      server.listen(0, ready);
      const one = ready;
      const two = one;
      const three = two;
      const four = three;
      server.listen(0, four);
      new WebSocketServer({ port: 0 });
      new NodeWS.WebSocketServer({ port: 0 });
      NodeHttpServer.layer(NodeHttp.createServer, { port: 0 });
      const portKey = "port";
      server.listen({ [portKey]: 0 });
      const method = "listen";
      server[method](0);
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 13);
    },
  );

  rule.valid(
    "allows port options the test may give a host through their name",
    `
      const later = { port: 0 };
      later.host = "127.0.0.1";
      server.listen(later);
      const keyed = { port: 0 };
      keyed[addressKey()] = "127.0.0.1";
      server.listen(keyed);
      const assigned = { port: 0 };
      Object.assign(assigned, loopbackOptions);
      server.listen(assigned);
      const self = { port: 0 };
      self[self] = "127.0.0.1";
      server.listen(self);
      const copied = { port: 0 };
      Object.assign(copied, { backlog: 511 }, { host: "127.0.0.1" });
      server.listen(copied);
      const spread = { port: 0 };
      Object.assign(spread, { ...loopbackOptions });
      server.listen(spread);
    `,
  );

  rule.valid(
    "allows a host deleted after the server listens",
    `
      const loopback = { port: 0, host: "127.0.0.1" };
      server.listen(loopback);
      delete loopback.host;
    `,
  );

  rule.valid(
    "ignores a host deleted in a branch its test never takes",
    `
      const never = false;
      const loopback = { port: 0, host: "127.0.0.1" };
      if (never) delete loopback.host;
      server.listen(loopback);
    `,
  );

  rule.invalid(
    "reports a host deleted in a branch its test always takes",
    `
      const always = true;
      const loopback = { port: 0, host: "127.0.0.1" };
      if (always) delete loopback.host;
      server.listen(loopback);
    `,
    (output) => assert.match(output, /listens on all interfaces/),
  );

  rule.invalid(
    "reports port options whose name changes leave them without a host",
    `
      const tuned = { port: 0 };
      tuned.backlog = 511;
      server.listen(tuned);
      const loopback = { port: 0, host: "127.0.0.1" };
      delete loopback.host;
      server.listen(loopback);
      const empty = {};
      empty.port = 0;
      server.listen(empty);
      const options = { port: 0 };
      const alias = options;
      alias.exclusive = true;
      new WebSocketServer(options);
      const tunedByAssign = { port: 0 };
      Object.assign(tunedByAssign, { backlog: 511 });
      server.listen(tunedByAssign);
      const portByAssign = {};
      Object.assign(portByAssign, { port: 0 });
      server.listen(portByAssign);
      const socket = { path: socketPath };
      socket.port = 0;
      server.listen(socket);
      server.listen({ port: 0, path: socketPath });
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 8);
    },
  );

  rule.invalid(
    "reads changes in order: a host a later change removes, or that only some runs or a callback add",
    `
      const readded = { port: 0 };
      readded.host = "127.0.0.1";
      delete readded.host;
      server.listen(readded);
      const gated = { port: 0 };
      if (process.env.CI) gated.host = "127.0.0.1";
      server.listen(gated);
      const deferred = { port: 0 };
      setImmediate(() => {
        deferred.host = "127.0.0.1";
      });
      server.listen(deferred);
      const base = { port: 0 };
      const tuned = Object.assign(base, { backlog: 511 });
      server.listen(tuned);
      {
        const Object = { assign: (target: object) => target };
        const local = { port: 0 };
        Object.assign(local, { host: "127.0.0.1" });
        server.listen(local);
      }
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 5);
    },
  );

  rule.valid(
    "allows options whose last change every run makes restores the host or removes the port",
    `
      const restored = { port: 0, host: "127.0.0.1" };
      delete restored.host;
      restored.host = "127.0.0.1";
      server.listen(restored);
      const detached = { port: 0 };
      delete detached.port;
      detached.noServer = true;
      new WebSocketServer(detached);
      const keyed = {};
      if (process.env.CI) keyed[process.env.KEY] = 0;
      server.listen(keyed);
      const copied = {};
      if (process.env.CI) Object.assign(copied, process.env);
      server.listen(copied);
    `,
  );

  rule.valid(
    "allows a port every run or branch arm that sets it gives a host, and a host ??= or ||= sets",
    `
      const branched = {};
      if (process.env.CI) Object.assign(branched, { port: 0, host: "127.0.0.1" });
      else Object.assign(branched, { path: socketPath });
      server.listen(branched);
      const nullish = { port: 0 };
      nullish.host ??= "127.0.0.1";
      server.listen(nullish);
      const falsy = { port: 0 };
      falsy.host ||= "127.0.0.1";
      server.listen(falsy);
      const armed = {};
      if (process.env.CI) {
        armed.port = 0;
        armed.host = "127.0.0.1";
      } else if (process.env.SOCKET) armed.path = socketPath;
      else {
        Object.assign(armed, { port: 0 });
        armed.host = "127.0.0.1";
      }
      server.listen(armed);
    `,
  );

  rule.invalid(
    "reports a port one arm of a branch sets and no later change of that arm gives a host",
    `
      const split = {};
      if (process.env.CI) {
        split.port = 0;
      } else {
        split.host = "127.0.0.1";
      }
      server.listen(split);
      const unhosted = {};
      if (process.env.CI) {
        unhosted.host = "127.0.0.1";
        unhosted.port = 0;
        delete unhosted.host;
      }
      server.listen(unhosted);
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 2);
    },
  );

  rule.valid(
    "allows a branch whose test changes the options before either arm runs",
    `
      const tested = {};
      if ((tested.backlog = 511) && process.env.CI) {
        tested.port = 0;
        tested.host = "127.0.0.1";
      } else {
        tested.path = socketPath;
      }
      server.listen(tested);
      const named = {};
      if ((named.host = "127.0.0.1")) {
        named.port = 0;
      }
      server.listen(named);
      const both = {};
      if ((both.host = "127.0.0.1") && process.env.CI) {
        both.port = 0;
      }
      server.listen(both);
      const picked = {};
      (picked.host = "127.0.0.1") ? (picked.port = 0) : (picked.path = socketPath);
      server.listen(picked);
    `,
  );

  rule.valid(
    "allows options Node listens on through a handle or descriptor, and a host a local undefined may hold",
    `
      server.listen({ fd: 3, port: 0, path: socketPath });
      server.listen({ handle, port: 0 });
      server.listen({ _handle: handle, port: 0 });
      server.listen({ fd: descriptor, port: 0 });
      NodeHttpServer.layer(NodeHttp.createServer, { fd: 0, port: 0 });
      const zero = { fd: 0, port: 0 };
      zero.fd &&= null;
      server.listen(zero);
      const refilled = { port: 0, host: undefined };
      refilled.host ||= "127.0.0.1";
      server.listen(refilled);
      function local(undefined) {
        server.listen({ port: 0, host: undefined });
        server.listen(0, undefined);
      }
    `,
  );

  rule.invalid(
    "reports a host Node takes as none, and a handle or descriptor Node or ws does not use",
    `
      server.listen({ port: 0, host: undefined });
      server.listen({ port: 0, host: "" });
      server.listen({ port: 0, host: null });
      server.listen({ port: 0, host: void 0 });
      server.listen(0, undefined);
      server.listen(0, "");
      server.listen(0, 511, () => {});
      server.listen(0, process.env.CI ? 128 : 511, () => {});
      server.listen(0, process.env.CI && 511);
      new WebSocketServer({ port: 0, fd: 3 });
      server.listen({ port: 0, fd: undefined });
      server.listen({ port: 0, fd: "3" });
      server.listen({ port: 0, fd: -1 });
      server.listen({ port: 0, handle: null });
      const cleared = { port: 0, host: "127.0.0.1" };
      cleared.host = undefined;
      server.listen(cleared);
      const emptied = { port: 0, host: "127.0.0.1" };
      emptied.host &&= "";
      server.listen(emptied);
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 16);
    },
  );

  rule.invalid(
    "reports a host a logical assignment leaves unset: &&= over none, ??= over an empty one",
    `
      const options = { port: 0 };
      options.host &&= "127.0.0.1";
      server.listen(options);
      const blank = { port: 0, host: "" };
      blank.host ??= "127.0.0.1";
      server.listen(blank);
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 2);
    },
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-wildcard-listen-in-tests");

productionRule.valid(
  "ignores non-test files",
  `
    server.listen(0);
  `,
);
