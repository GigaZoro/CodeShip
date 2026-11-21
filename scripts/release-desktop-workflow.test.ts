// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as plain text, like GitHub does.
import * as NodeFS from "node:fs";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const Step = Schema.Record(Schema.String, Schema.Unknown);
const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    build: Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      steps: Schema.Array(Step),
    }),
  }),
});
const build = Schema.decodeSync(fromYaml(Workflow))(
  NodeFS.readFileSync(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
).jobs.build;

const runOf = (step: typeof Step.Type) => (typeof step.run === "string" ? step.run : "");
const readsSecrets = (value: unknown) => /\$\{\{\s*secrets\./.test(JSON.stringify(value));
const builds = build.steps.flatMap((step, index) => {
  const run = runOf(step);
  if (!/dist:desktop:artifact|build-cli-archive\.ts/.test(run)) return [];
  return [
    {
      index,
      name: step.name,
      phase: /--phase\s+(\w+)/.exec(run)?.[1],
      stageDir: /--stage-dir\s+"([^"]+)"/.exec(run)?.[1],
    },
  ];
});

describe("desktop release build", () => {
  it("installs and stages every dependency before signing secrets reach the runner", () => {
    const lastStage = builds.findLast((step) => step.phase === "stage");
    expect(lastStage).toBeDefined();

    expect(readsSecrets(build.env ?? {})).toBe(false);
    const earlySecretSteps = build.steps
      .slice(0, lastStage!.index + 1)
      .filter(readsSecrets)
      .map((step) => step.name);
    expect(earlySecretSteps).toEqual([]);
  });

  it("signs only what an earlier stage step built", () => {
    // A build without a phase installs and signs in the same step.
    expect(builds.filter((step) => step.phase !== "stage" && step.phase !== "package")).toEqual([]);
    for (const packaged of builds.filter((step) => step.phase === "package")) {
      const staged = builds.find(
        (step) =>
          step.phase === "stage" &&
          step.index < packaged.index &&
          step.stageDir === packaged.stageDir,
      );
      expect(staged, String(packaged.name)).toBeDefined();
    }
  });
});
