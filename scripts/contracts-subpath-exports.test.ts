// @effect-diagnostics nodeBuiltinImport:off - Static package export and import guard test.
// @test-input ../packages/contracts/package.json
// @test-input ../packages/contracts/src/index.ts
// @test-input ../packages/contracts/src/*.ts
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const contractsDir = NodePath.join(repoRoot, "packages", "contracts");

const ROOT_BARREL_IMPORT_PATTERN =
  /(?:\bfrom\s*["']@t3tools\/contracts["']|\bimport\s*["']@t3tools\/contracts["']|\b(?:import|require)\s*\(\s*["']@t3tools\/contracts["']\s*\))/;

const INDEX_REEXPORT_PATTERN =
  /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']\.\/([^"']+)\.ts["'];?/gm;

function stripJsComments(source: string): string {
  return source.replace(
    /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (match) => (match.startsWith("/") ? " " : match),
  );
}

function hasRootBarrelImport(source: string): boolean {
  return ROOT_BARREL_IMPORT_PATTERN.test(stripJsComments(source));
}

function extractIndexReexportedModules(source: string): string[] {
  return [...stripJsComments(source).matchAll(INDEX_REEXPORT_PATTERN)].map((match) => match[1]!);
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  if (!NodeFS.existsSync(dir)) return out;
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".t3") continue;
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(full, out);
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("@t3tools/contracts subpath exports", () => {
  it("exports every domain module re-exported by index.ts (plus ./relay) as an explicit subpath", () => {
    const pkg = JSON.parse(
      NodeFS.readFileSync(NodePath.join(contractsDir, "package.json"), "utf8"),
    ) as {
      readonly exports: Record<string, { readonly types: string; readonly import: string }>;
    };
    const indexSrc = NodeFS.readFileSync(NodePath.join(contractsDir, "src", "index.ts"), "utf8");
    const indexModules = extractIndexReexportedModules(indexSrc);

    expect(pkg.exports["."]).toEqual({
      types: "./src/index.ts",
      import: "./src/index.ts",
    });

    const expectedSubpaths = new Set([...indexModules, "relay"]);
    const missing: string[] = [];
    for (const mod of expectedSubpaths) {
      const expected = {
        types: `./src/${mod}.ts`,
        import: `./src/${mod}.ts`,
      };
      if (
        pkg.exports[`./${mod}`]?.types !== expected.types ||
        pkg.exports[`./${mod}`]?.import !== expected.import
      ) {
        missing.push(`./${mod}`);
      }
    }
    expect(missing).toEqual([]);

    const invalidTargets: string[] = [];
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (subpath === ".") continue;
      if (
        !subpath.startsWith("./") ||
        target.types !== target.import ||
        !target.import.startsWith("./src/") ||
        !target.import.endsWith(".ts") ||
        target.import.endsWith(".test.ts") ||
        !NodeFS.existsSync(NodePath.join(contractsDir, target.import))
      ) {
        invalidTargets.push(`${subpath} -> ${JSON.stringify(target)}`);
      }
    }
    expect(invalidTargets).toEqual([]);
  });

  it("keeps shared packages, adapters, relay, server, and mobile-behavior scripts off the root barrel", () => {
    const guardedDirs = [
      "packages/shared/src",
      "packages/ssh/src",
      "packages/tailscale/src",
      "infra/relay/src",
      "apps/server/src",
      "apps/server/integration",
      "apps/server/scripts",
      "scripts/mobile-behavior",
    ];
    for (const entry of NodeFS.readdirSync(NodePath.join(repoRoot, "packages"), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name.startsWith("provider-") ||
        entry.name.startsWith("source-control-") ||
        entry.name.startsWith("secret-provider-")
      ) {
        guardedDirs.push(`packages/${entry.name}/src`);
      }
    }

    const offenders: string[] = [];
    for (const relDir of guardedDirs) {
      for (const file of collectTypeScriptFiles(NodePath.join(repoRoot, relDir))) {
        const content = NodeFS.readFileSync(file, "utf8");
        if (hasRootBarrelImport(content)) {
          offenders.push(NodePath.relative(repoRoot, file).split(NodePath.sep).join("/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("matches all root-barrel import forms while ignoring comments and detects varied index re-exports", () => {
    expect(hasRootBarrelImport(`// import { Foo } from "@t3tools/contracts";`)).toBe(false);
    expect(hasRootBarrelImport(`/* export * from "@t3tools/contracts"; */\nconst ok = 1;`)).toBe(
      false,
    );
    expect(hasRootBarrelImport(`import { Foo } from "@t3tools/contracts/baseSchemas";`)).toBe(
      false,
    );

    expect(hasRootBarrelImport(`import { Foo } from "@t3tools/contracts";`)).toBe(true);
    expect(hasRootBarrelImport(`import type { Foo } from '@t3tools/contracts';`)).toBe(true);
    expect(hasRootBarrelImport(`export { Foo } from "@t3tools/contracts";`)).toBe(true);
    expect(hasRootBarrelImport(`export * from '@t3tools/contracts';`)).toBe(true);
    expect(hasRootBarrelImport(`import "@t3tools/contracts";`)).toBe(true);
    expect(hasRootBarrelImport(`import/*c*/"@t3tools/contracts";`)).toBe(true);
    expect(hasRootBarrelImport(`type S = import("@t3tools/contracts").ServerSettings;`)).toBe(true);
    expect(hasRootBarrelImport(`const c = require('@t3tools/contracts');`)).toBe(true);

    expect(
      extractIndexReexportedModules(
        [
          `// export * from "./ignored.ts";`,
          `export * from "./alpha.ts";`,
          `export type * from './beta.ts';`,
          `export { Foo, type Bar } from "./gamma.ts";`,
          `export type { Baz } from './delta.ts';`,
          `export * as ns from "./epsilon.ts";`,
        ].join("\n"),
      ),
    ).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
  });
});
