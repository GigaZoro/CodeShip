// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as plain text, like GitHub does.
import * as NodeFS from "node:fs";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const Step = Schema.Record(Schema.String, Schema.Unknown);
const Workflow = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  jobs: Schema.Struct({
    build: Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      steps: Schema.Array(Step),
    }),
  }),
});
const workflow = Schema.decodeSync(fromYaml(Workflow))(
  NodeFS.readFileSync(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
);
const build = workflow.jobs.build;

const runOf = (step: typeof Step.Type) => (typeof step.run === "string" ? step.run : "");
const readsSecrets = (value: unknown) => /\$\{\{\s*secrets\./.test(JSON.stringify(value));
const builds = build.steps.flatMap((step, index) => {
  const run = runOf(step);
  const kind = /dist:desktop:artifact/.test(run)
    ? "desktop"
    : /build-cli-archive\.ts/.test(run)
      ? "cli"
      : undefined;
  if (kind === undefined) return [];
  return [
    {
      index,
      kind,
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

    expect(readsSecrets(workflow.env ?? {})).toBe(false);
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
    for (const kind of ["cli", "desktop"]) {
      expect(builds.filter((step) => step.kind === kind).map((step) => step.phase)).toEqual([
        "stage",
        "package",
      ]);
    }
    for (const packaged of builds.filter((step) => step.phase === "package")) {
      const staged = builds.find(
        (step) =>
          step.phase === "stage" &&
          step.kind === packaged.kind &&
          step.index < packaged.index &&
          step.stageDir === packaged.stageDir,
      );
      expect(staged, String(packaged.name)).toBeDefined();
    }
  });

  it("hands the relay tracing config to the CLI executable build alone", () => {
    const readers = build.steps.flatMap((step, index) =>
      JSON.stringify(step).includes("relay-client-tracing") ? [index] : [],
    );
    const download = build.steps.findIndex(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/download-artifact@") &&
        JSON.stringify(step.with).includes("relay-client-tracing-config"),
    );
    // Downloaded just before the one step that reads it, which deletes it on exit and keeps it
    // out of $GITHUB_ENV, so no later install can read it.
    expect(readers).toEqual([download, download + 1]);
    const reader = runOf(build.steps[download + 1]!);
    expect(reader).toContain("build-exe");
    expect(reader).toMatch(/trap 'rm -rf "\$config_dir"' EXIT/);
    expect(reader).not.toContain("GITHUB_ENV");
  });
});
