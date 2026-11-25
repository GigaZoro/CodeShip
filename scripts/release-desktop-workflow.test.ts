// @effect-diagnostics nodeBuiltinImport:off - Reads the workflow file as plain text, like GitHub does, and runs its shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import { isWindowsHost } from "@t3tools/shared/testing/hostPlatform";
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
const readsSecrets = (value: unknown) => /\$\{\{[^}]*\bsecrets\./.test(JSON.stringify(value));
const builds = build.steps.flatMap((step, index) => {
  const run = runOf(step);
  // Awaiting notarization reads only the App Store Connect key; it builds and signs nothing.
  const kind = /dist:desktop:artifact/.test(run)
    ? "desktop"
    : /build-cli-archive\.ts(?! await-notarization)/.test(run)
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

  it("removes the signing material a step wrote before the next step runs", () => {
    // Steps after signing run the archive and the app, so nothing a signing step wrote or
    // unlocked may outlive it.
    for (const step of build.steps.filter(readsSecrets)) {
      const run = runOf(step);
      const name = String(step.name);
      expect(run, name).not.toMatch(/GITHUB_ENV|GITHUB_PATH|GITHUB_OUTPUT/);
      const written = [...run.matchAll(/printf '%s' "\$\w+"[^\n>]*>\s*"\$(\w+)"/g)].map(
        (match) => match[1]!,
      );
      const keychains = [...run.matchAll(/security create-keychain .* "([^"]+)"\n/g)].map(
        (match) => match[1]!,
      );
      if (written.length === 0 && keychains.length === 0) continue;
      expect(run, name).toMatch(/trap cleanup EXIT/);
      for (const variable of written) {
        expect(run, `${name}: ${variable}`).toMatch(new RegExp(`\\b${variable}="\\$signing_dir/`));
      }
      for (const keychain of keychains) {
        expect(keychain, name).toMatch(/^\$signing_dir\//);
      }
      if (/dist:desktop:artifact/.test(run)) {
        // electron-builder makes its own keychain from CSC_LINK in this folder.
        expect(run, name).toContain('export APP_BUILDER_TMP_DIR="$signing_dir/');
        expect(run, name).toContain('export ELECTRON_BUILDER_CACHE="$signing_dir/');
      }
    }
  });

  it("gives each platform only the secrets it signs with", () => {
    for (const step of build.steps.filter(readsSecrets)) {
      for (const [variable, value] of Object.entries(step.env ?? {})) {
        if (!readsSecrets(value)) continue;
        const scoped = /^\$\{\{ inputs\.platform == '(\w+)' && secrets\.(\w+) \|\| '' \}\}$/.exec(
          String(value),
        );
        expect(scoped, `${String(step.name)}: ${variable}`).not.toBeNull();
        expect(scoped![1], `${String(step.name)}: ${variable}`).toBe(
          scoped![2]!.startsWith("AZURE_") ? "win" : "mac",
        );
      }
    }
  });

  describe.skipIf(isWindowsHost)("signing step cleanup", () => {
    const cleanupSteps = build.steps.filter(
      (step) => readsSecrets(step) && runOf(step).includes("trap cleanup EXIT"),
    );
    const keychainSteps = cleanupSteps.filter((step) =>
      /security create-keychain|dist:desktop:artifact/.test(runOf(step)),
    );
    // A keychain electron-builder added, in a folder whose path has a space.
    const securityStub = `#!/bin/sh
echo "$*" >> "$FIXTURE_ROOT/security.log"
case "$1" in
  list-keychains) printf '    "%s"\\n' "$HOME/login.keychain-db" "$(cat "$FIXTURE_ROOT/signing-dir")/electron builder.keychain" ;;
  delete-keychain) exit "$DELETE_STATUS" ;;
esac
`;
    const runCleanup = (step: typeof Step.Type, deleteStatus: number, body: string) => {
      const run = runOf(step);
      const prelude = run.slice(
        run.indexOf('signing_dir=""'),
        run.indexOf("trap cleanup EXIT") + "trap cleanup EXIT".length,
      );
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-signing-cleanup-"));
      try {
        NodeFS.mkdirSync(NodePath.join(root, "bin"));
        NodeFS.writeFileSync(NodePath.join(root, "bin", "security"), securityStub, { mode: 0o755 });
        const script = `${prelude}
signing_dir="$(mktemp -d "$FIXTURE_ROOT/signing dir.XXXXXX")"
keychain="$signing_dir/signing.keychain-db"
touch "$keychain" "$signing_dir/AuthKey.p8"
printf '%s' "$signing_dir" > "$FIXTURE_ROOT/signing-dir"
${body}
`;
        const result = NodeChildProcess.spawnSync(
          "bash",
          ["--noprofile", "--norc", "-eo", "pipefail", "-c", script],
          {
            env: {
              PATH: `${NodePath.join(root, "bin")}:${process.env.PATH ?? ""}`,
              HOME: root,
              FIXTURE_ROOT: root,
              DELETE_STATUS: String(deleteStatus),
            },
            encoding: "utf8",
          },
        );
        const signingDir = NodeFS.readFileSync(NodePath.join(root, "signing-dir"), "utf8");
        const securityLog = NodePath.join(root, "security.log");
        return {
          status: result.status,
          stderr: result.stderr,
          signingDirLeft: NodeFS.existsSync(signingDir),
          deleted: (NodeFS.existsSync(securityLog) ? NodeFS.readFileSync(securityLog, "utf8") : "")
            .split("\n")
            .filter((line) => line.startsWith("delete-keychain "))
            .map((line) => line.slice("delete-keychain ".length).replace(signingDir, "<signing>")),
        };
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    };

    it("runs a signing step's cleanup in each step that writes signing material", () => {
      expect(cleanupSteps.map((step) => step.name)).toEqual([
        "Package CLI archive",
        "Package desktop artifact",
        "Await CLI notarization",
      ]);
      expect(keychainSteps.map((step) => step.name)).toEqual([
        "Package CLI archive",
        "Package desktop artifact",
      ]);
    });

    it.each(keychainSteps.map((step) => [String(step.name), step] as const))(
      "%s removes every keychain and the folder even when a removal fails",
      (_name, step) => {
        const result = runCleanup(step, 1, "exit 0");

        expect(result.deleted).toEqual([
          "<signing>/electron builder.keychain",
          "<signing>/signing.keychain-db",
        ]);
        expect(result.signingDirLeft).toBe(false);
        expect(result.status, result.stderr).toBe(1);
      },
    );

    it.each(cleanupSteps.map((step) => [String(step.name), step] as const))(
      "%s keeps the failure of the build it cleans up after",
      (_name, step) => {
        const result = runCleanup(step, 0, "exit 3");

        expect(result.signingDirLeft).toBe(false);
        expect(result.status, result.stderr).toBe(3);
      },
    );
  });

  it("reads a relay tracing value that ends in '='", () => {
    const reader = runOf(
      build.steps.find((step) => runOf(step).includes("relay-client-tracing.env"))!,
    );
    expect(reader).not.toMatch(/IFS='='/);
    expect(reader).toContain('value="${line#*=}"');
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
