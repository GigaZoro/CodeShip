import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-checkout-temp-dir-in-tests", {
  filename: "fixture.test.ts",
});

describe("t3code/no-checkout-temp-dir-in-tests", () => {
  rule.valid(
    "allows temp folders under the system temp folder and paths it cannot place",
    `
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-"));
      const temp = NodeOS.tmpdir();
      NodeFS.mkdtempSync(NodePath.join(temp, "t3-"));
      NodeFS.mkdtempSync(\`\${NodeOS.tmpdir()}/t3-\`);
      NodeFS.mkdtempSync("/tmp/t3-");
      NodeFS.mkdtempSync(NodePath.join(pathEntryTempRoot(), "agent-scope-"));
      fs.makeTempDirectoryScoped({ prefix: "t3-" });
      fs.makeTempDirectoryScoped({ directory: baseDir, prefix: "t3-" });
      fs.makeTempDirectory({ directory: NodeOS.tmpdir() });
      let changing = ".";
      NodeFS.mkdtempSync(NodePath.join(changing, "t3-"));
    `,
  );

  rule.invalid(
    "reports temp folders that start in the checkout",
    `
      NodeFS.mkdtempSync(".t3-agent-scope-");
      NodeFS.mkdtempSync(\`.t3-\${id}-\`);
      NodeFS.mkdtempSync(NodePath.join(import.meta.dirname, ".knip-test-"));
      NodeFS.mkdtempSync(path.join(__dirname, "fixture-"));
      mkdtemp(NodePath.resolve(process.cwd(), "t3-"));
      const root = NodePath.join(import.meta.dirname, "tmp");
      NodeFS.mkdtempSync(NodePath.join(root, "knip-test-"));
      fs.makeTempDirectoryScoped({ directory: ".", prefix: ".t3-invocation-" });
      fs.makeTempDirectory({ directory: import.meta.dirname });
    `,
    (output) => {
      assert.match(output, /inside the checkout/);
      assert.equal(output.match(/no-checkout-temp-dir-in-tests/g)?.length, 8);
    },
  );
});

const productionRule = createOxlintRuleHarness("t3code/no-checkout-temp-dir-in-tests");

productionRule.valid(
  "ignores non-test files",
  `
    NodeFS.mkdtempSync(".t3-");
  `,
);
