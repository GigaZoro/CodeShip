import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-wildcard-listen-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-wildcard-listen-in-tests", () => {
  rule.valid(
    "allows servers that name their address, socket paths and arguments it cannot tell apart",
    `
      server.listen(0, "127.0.0.1", () => {});
      server.listen(port, host);
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
      new WebSocketServer({ port: 0 });
      new NodeWS.WebSocketServer({ port: 0 });
      NodeHttpServer.layer(NodeHttp.createServer, { port: 0 });
    `,
    (output) => {
      assert.match(output, /listens on all interfaces/);
      assert.equal(output.match(/no-wildcard-listen-in-tests/g)?.length, 10);
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
