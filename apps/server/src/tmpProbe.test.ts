// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as CP from "node:child_process";
import { expect, it } from "vitest";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";

const run = (detached: boolean, shell: boolean, windowsHide: boolean) =>
  new Promise<string>((resolve) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "probe-"));
    const cli = writeFakeCli({
      directory: dir,
      name: "p",
      source: `process.stdin.setEncoding("utf8"); process.stdin.on("data", d => { process.stdout.write("echo:" + d); process.exit(0); });`,
    });
    const child = CP.spawn(shell ? `"${cli}"` : cli, ["agent", "stdio"], { detached, shell, windowsHide, stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => resolve(`error ${e.message}`));
    child.stdin.write("hello\n");
    const timer = setTimeout(() => { child.kill(); resolve(`TIMEOUT out=${out}`); }, 8000);
    child.on("exit", () => { clearTimeout(timer); setTimeout(() => resolve(`exit out=${out.trim()}`), 200); });
  });

it("probe", async () => {
  const results: Array<string> = [];
  for (const detached of [false, true]) for (const shell of [true]) for (const windowsHide of [false, true]) {
    results.push(`PROBE detached=${detached} shell=${shell} hide=${windowsHide}: ${await run(detached, shell, windowsHide)}`);
  }
  console.error(results.join("\n"));
  expect(true).toBe(true);
}, 60000);
