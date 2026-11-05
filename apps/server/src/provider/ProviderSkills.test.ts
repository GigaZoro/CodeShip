import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PROVIDER_SKILL_MAX_BYTES,
  PROVIDER_SKILL_MAX_FILES,
  ProviderInstanceId,
  type ProviderSkillFile,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderSkills from "./ProviderSkills.ts";

const sourceId = ProviderInstanceId.make("claudeAgent");
const targetId = ProviderInstanceId.make("claudeAgent_work");
const bareId = ProviderInstanceId.make("cursor");

const file = (path: string, text = "x"): ProviderSkillFile => ({
  path,
  contentBase64: Buffer.from(text).toString("base64"),
});

const makeHarness = Effect.fn("test.makeHarness")(function* (options?: {
  readonly homeIsRoot?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-" }));
  const sourceSkills = path.join(root, "source", "skills");
  const targetSkills = path.join(root, "target", "skills");
  const refreshed = yield* Queue.unbounded<string>();

  const continuationIdentity = { driverKind: "claudeAgent", continuationKey: "claude:home:a" };
  const instances: Record<string, ProviderInstance> = {
    [sourceId]: {
      instanceId: sourceId,
      continuationIdentity,
      personalSkillsDirectory: sourceSkills,
    } as unknown as ProviderInstance,
    [targetId]: {
      instanceId: targetId,
      continuationIdentity,
      personalSkillsDirectory: targetSkills,
    } as unknown as ProviderInstance,
    [bareId]: { instanceId: bareId, continuationIdentity } as unknown as ProviderInstance,
  };
  const reported: Array<{ path: string; name?: string; enabled?: boolean }> = [];
  // Skills whose reported state ignores the toggle, like one pinned by a project settings file.
  const pinned = new Set<string>();
  const refresh = { fails: false };
  const toggled: Array<{
    readonly name: string;
    readonly path: string;
    readonly enabled: boolean;
  }> = [];
  instances[sourceId] = {
    ...instances[sourceId],
    setSkillEnabled: (input: (typeof toggled)[number]) =>
      Effect.sync(() => {
        toggled.push(input);
        const entry = reported.find((candidate) => candidate.path === input.path);
        if (entry !== undefined && !pinned.has(input.path)) entry.enabled = input.enabled;
      }),
  } as unknown as ProviderInstance;
  const layer = ProviderSkills.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (id) => Effect.succeed(instances[id]),
        listInstances: Effect.succeed(Object.values(instances)),
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(
          () =>
            [
              { instanceId: sourceId, skills: reported, workspaceSnapshots: [] },
            ] as unknown as ReadonlyArray<ServerProvider>,
        ),
        refreshInstance: (id) =>
          refresh.fails
            ? Effect.die("probe failed")
            : Queue.offer(refreshed, id).pipe(Effect.as<ReadonlyArray<ServerProvider>>([])),
      }),
    ),
    Layer.provide(NodeServices.layer),
    // A home folder that holds no skills keeps them outside it unless a test opts in.
    Layer.provide(
      Layer.succeed(
        HostProcess.HomeDirectory,
        options?.homeIsRoot === true ? root : path.join(root, "home"),
      ),
    ),
  );

  /** A skill on the source machine that its provider lists. */
  const writeSkill = Effect.fn("test.writeSkill")(function* (
    name: string,
    entries: Record<string, string | Uint8Array>,
  ) {
    for (const [relative, contents] of Object.entries(entries)) {
      const absolute = path.join(sourceSkills, name, relative);
      yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
      yield* fs.writeFile(
        absolute,
        typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
      );
    }
    const skillPath = path.join(sourceSkills, name, "SKILL.md");
    reported.push({ path: skillPath });
    return skillPath;
  });

  return {
    fs,
    path,
    root,
    sourceSkills,
    targetSkills,
    refreshed,
    reported,
    toggled,
    pinned,
    refresh,
    layer,
    writeSkill,
  };
});

it.layer(NodeServices.layer)("ProviderSkills", (it) => {
  it.effect("copies a skill between instances byte for byte and skips symlinks", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const binary = new Uint8Array([0, 255, 128, 7]);
      const skillPath = yield* h.writeSkill("review", {
        "SKILL.md": "---\nname: review\n---\nBody",
        "scripts/run.sh": "echo hi",
        "assets/icon.bin": binary,
      });
      yield* h.fs.writeFile(h.path.join(h.root, "outside.txt"), new TextEncoder().encode("secret"));
      yield* h.fs.symlink(
        h.path.join(h.root, "outside.txt"),
        h.path.join(h.sourceSkills, "review", "leak.txt"),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const exported = yield* service.exportSkill({ instanceId: sourceId, skillPath });
        assert.equal(exported.name, "review");
        assert.deepEqual(exported.files.map((entry) => entry.path).toSorted(), [
          "SKILL.md",
          "assets/icon.bin",
          "scripts/run.sh",
        ]);

        const installed = yield* service.installSkill({
          instanceId: targetId,
          name: exported.name,
          files: exported.files,
          overwrite: false,
        });
        assert.equal(installed.fileCount, 3);
        const copy = h.path.join(h.targetSkills, "review");
        assert.deepEqual(
          Array.from(yield* h.fs.readFile(h.path.join(copy, "assets", "icon.bin"))),
          Array.from(binary),
        );
        assert.equal(yield* h.fs.readFileString(h.path.join(copy, "scripts", "run.sh")), "echo hi");
        // Accounts on one home share the folder, so each is refreshed.
        assert.sameMembers(
          [
            yield* Queue.take(h.refreshed),
            yield* Queue.take(h.refreshed),
            yield* Queue.take(h.refreshed),
          ],
          [sourceId, targetId, bareId],
        );
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("refuses to replace an existing skill unless asked, and replaces it whole", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const install = (files: ReadonlyArray<ProviderSkillFile>, overwrite: boolean) =>
          service.installSkill({ instanceId: targetId, name: "tidy", files, overwrite });
        yield* install([file("SKILL.md", "v1"), file("old.txt")], false);

        const refused = yield* install([file("SKILL.md", "v2")], false).pipe(Effect.flip);
        assert.equal(refused.reason, "alreadyExists");
        assert.equal(
          yield* h.fs.readFileString(h.path.join(h.targetSkills, "tidy", "SKILL.md")),
          "v1",
        );

        yield* install([file("SKILL.md", "v2")], true);
        const target = h.path.join(h.targetSkills, "tidy");
        assert.equal(yield* h.fs.readFileString(h.path.join(target, "SKILL.md")), "v2");
        assert.isFalse(yield* h.fs.exists(h.path.join(target, "old.txt")));
        // No staging or backup folder survives; only their empty container stays.
        assert.deepEqual((yield* h.fs.readDirectory(h.targetSkills)).toSorted(), [
          ".codeship-staging",
          "tidy",
        ]);
        assert.deepEqual(
          yield* h.fs.readDirectory(h.path.join(h.targetSkills, ".codeship-staging")),
          [],
        );
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("rejects unsafe names and paths before writing anything", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const attempt = (name: string, files: ReadonlyArray<ProviderSkillFile>) =>
          service
            .installSkill({ instanceId: targetId, name, files, overwrite: true })
            .pipe(Effect.flip);
        const skill = file("SKILL.md");

        for (const name of ["", "..", ".", "a/b", "a\\b", ".hidden", "-x", "a b", "x".repeat(65)]) {
          assert.equal((yield* attempt(name, [skill])).reason, "invalidName", name);
        }
        for (const bad of [
          "../escape.txt",
          "a/../../escape.txt",
          "/abs.txt",
          "a//b.txt",
          "a\\b.txt",
          "C:/x.txt",
          "./x.txt",
          "a/\u0000.txt",
        ]) {
          assert.equal((yield* attempt("ok", [skill, file(bad)])).reason, "invalidPath", bad);
        }
        assert.equal((yield* attempt("ok", [skill, skill])).reason, "invalidPath");
        assert.equal((yield* attempt("ok", [file("notes.md")])).reason, "missingSkillFile");
        assert.isFalse(yield* h.fs.exists(h.targetSkills));
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("enforces the file count and size limits on install and export", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const install = (files: ReadonlyArray<ProviderSkillFile>) =>
          service
            .installSkill({ instanceId: targetId, name: "big", files, overwrite: true })
            .pipe(Effect.flip);

        const many = Array.from({ length: PROVIDER_SKILL_MAX_FILES + 1 }, (_, index) =>
          file(index === 0 ? "SKILL.md" : `f${index}.txt`),
        );
        assert.equal((yield* install(many)).reason, "tooManyFiles");
        const atLimit = many.slice(0, PROVIDER_SKILL_MAX_FILES);
        assert.equal(
          (yield* service.installSkill({
            instanceId: targetId,
            name: "big",
            files: atLimit,
            overwrite: true,
          })).fileCount,
          PROVIDER_SKILL_MAX_FILES,
        );

        const chunk = "a".repeat(PROVIDER_SKILL_MAX_BYTES / 2 + 1);
        assert.equal(
          (yield* install([file("SKILL.md", chunk), file("two.txt", chunk)])).reason,
          "tooLarge",
        );

        const manyOnDisk = yield* h.writeSkill(
          "many",
          Object.fromEntries(
            Array.from({ length: PROVIDER_SKILL_MAX_FILES + 1 }, (_, index) => [
              index === 0 ? "SKILL.md" : `f${index}.txt`,
              "x",
            ]),
          ),
        );
        assert.equal(
          (yield* service
            .exportSkill({ instanceId: sourceId, skillPath: manyOnDisk })
            .pipe(Effect.flip)).reason,
          "tooManyFiles",
        );
        const heavy = yield* h.writeSkill("heavy", {
          "SKILL.md": "x",
          "blob.bin": new Uint8Array(PROVIDER_SKILL_MAX_BYTES),
        });
        assert.equal(
          (yield* service.exportSkill({ instanceId: sourceId, skillPath: heavy }).pipe(Effect.flip))
            .reason,
          "tooLarge",
        );
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("only exports skills the provider lists and only installs where it can", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        yield* h.fs.writeFileString(h.path.join(h.root, "SKILL.md"), "unlisted");
        const unlisted = yield* service
          .exportSkill({ instanceId: sourceId, skillPath: h.path.join(h.root, "SKILL.md") })
          .pipe(Effect.flip);
        assert.equal(unlisted.reason, "skillNotFound");

        const unsupported = yield* service
          .installSkill({
            instanceId: bareId,
            name: "a",
            files: [file("SKILL.md")],
            overwrite: false,
          })
          .pipe(Effect.flip);
        assert.equal(unsupported.reason, "unsupported");

        const missing = yield* service
          .installSkill({
            instanceId: ProviderInstanceId.make("gone"),
            name: "a",
            files: [file("SKILL.md")],
            overwrite: false,
          })
          .pipe(Effect.flip);
        assert.equal(missing.reason, "instanceNotFound");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("refuses to copy a linked skill and reports where it points", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const managed = h.path.join(h.root, "agent-config", "linked");
      yield* h.fs.makeDirectory(managed, { recursive: true });
      yield* h.fs.writeFileString(h.path.join(managed, "SKILL.md"), "managed");
      yield* h.fs.makeDirectory(h.sourceSkills, { recursive: true });
      yield* h.fs.symlink(managed, h.path.join(h.sourceSkills, "linked"));
      const skillPath = h.path.join(h.sourceSkills, "linked", "SKILL.md");
      yield* Effect.sync(() => void h.reported.push({ path: skillPath }));

      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const exported = yield* service
          .exportSkill({ instanceId: sourceId, skillPath })
          .pipe(Effect.flip);
        assert.equal(exported.reason, "linkedSkill");
        assert.equal(exported.linkTarget, managed);

        const outside = h.path.join(h.root, "elsewhere");
        yield* h.fs.makeDirectory(outside, { recursive: true });
        yield* h.fs.makeDirectory(h.targetSkills, { recursive: true });
        yield* h.fs.symlink(outside, h.path.join(h.targetSkills, "linked"));
        const refused = yield* service
          .installSkill({
            instanceId: targetId,
            name: "linked",
            files: [file("SKILL.md")],
            overwrite: true,
          })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "linkedSkill");
        assert.deepEqual(yield* h.fs.readDirectory(outside), []);
        assert.equal(yield* h.fs.readLink(h.path.join(h.targetSkills, "linked")), outside);

        // A skill kept in a git checkout is managed there even without a link.
        const tracked = h.path.join(h.sourceSkills, "tracked");
        yield* h.fs.makeDirectory(tracked, { recursive: true });
        yield* h.fs.writeFileString(h.path.join(tracked, "SKILL.md"), "tracked");
        yield* h.fs.makeDirectory(h.path.join(h.sourceSkills, ".git"));
        const trackedPath = h.path.join(tracked, "SKILL.md");
        yield* Effect.sync(() => void h.reported.push({ path: trackedPath }));
        const trackedExport = yield* service
          .exportSkill({ instanceId: sourceId, skillPath: trackedPath })
          .pipe(Effect.flip);
        assert.equal(trackedExport.reason, "linkedSkill");

        // Installing into a git checkout would add files the repository doesn't track.
        yield* h.fs.makeDirectory(h.path.join(h.targetSkills, ".git"));
        const intoRepository = yield* service
          .installSkill({
            instanceId: targetId,
            name: "fresh",
            files: [file("SKILL.md")],
            overwrite: false,
          })
          .pipe(Effect.flip);
        assert.equal(intoRepository.reason, "linkedSkill");
        assert.isFalse(yield* h.fs.exists(h.path.join(h.targetSkills, "fresh")));
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("stops looking for a managing repository at the home folder", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ homeIsRoot: true });
      // A dotfiles repository at home must not make every skill look managed.
      yield* h.fs.makeDirectory(h.path.join(h.root, ".git"));
      const plain = yield* h.writeSkill("plain", { "SKILL.md": "body" });
      // A repository below home, like the agent-config clone, still manages its skills.
      const clone = h.path.join(h.root, "agent-config", "skills", "managed");
      yield* h.fs.makeDirectory(clone, { recursive: true });
      yield* h.fs.writeFileString(h.path.join(clone, "SKILL.md"), "managed");
      yield* h.fs.makeDirectory(h.path.join(h.root, "agent-config", ".git"));
      const managedPath = h.path.join(clone, "SKILL.md");
      h.reported.push({ path: managedPath });

      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const exported = yield* service.exportSkill({ instanceId: sourceId, skillPath: plain });
        assert.equal(exported.name, "plain");
        const managed = yield* service
          .exportSkill({ instanceId: sourceId, skillPath: managedPath })
          .pipe(Effect.flip);
        assert.equal(managed.reason, "linkedSkill");
        const installed = yield* service.installSkill({
          instanceId: targetId,
          name: "fresh",
          files: [file("SKILL.md")],
          overwrite: false,
        });
        assert.equal(installed.fileCount, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("keeps looking above skills that live outside the home folder", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.fs.makeDirectory(h.path.join(h.root, ".git"));
      const skillPath = yield* h.writeSkill("outside", { "SKILL.md": "body" });
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const refused = yield* service
          .exportSkill({ instanceId: sourceId, skillPath })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "linkedSkill");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("follows links that stay inside the skill and counts the ones that leave it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const skillPath = yield* h.writeSkill("linky", {
        "SKILL.md": "body",
        "real/data.txt": "data",
      });
      const root = h.path.join(h.sourceSkills, "linky");
      yield* h.fs.writeFileString(h.path.join(h.root, "outside.txt"), "secret");
      yield* h.fs.symlink("real", h.path.join(root, "alias"));
      yield* h.fs.symlink("real/data.txt", h.path.join(root, "shortcut.txt"));
      yield* h.fs.symlink(h.path.join(h.root, "outside.txt"), h.path.join(root, "leak.txt"));
      yield* h.fs.symlink("missing", h.path.join(root, "broken"));
      yield* h.fs.symlink(".", h.path.join(root, "real", "loop"));

      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const exported = yield* service.exportSkill({ instanceId: sourceId, skillPath });
        assert.deepEqual(exported.files.map((entry) => entry.path).toSorted(), [
          "SKILL.md",
          "alias/data.txt",
          "real/data.txt",
          "shortcut.txt",
        ]);
        // leak, broken, and the loop, which is seen under both real/ and alias/.
        assert.equal(exported.skippedLinks, 4);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("keeps executable bits and installs a readable folder", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const skillPath = yield* h.writeSkill("run", {
        "SKILL.md": "body",
        "scripts/go.sh": "echo go",
      });
      yield* h.fs.chmod(h.path.join(h.sourceSkills, "run", "scripts", "go.sh"), 0o755);

      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const exported = yield* service.exportSkill({ instanceId: sourceId, skillPath });
        assert.deepEqual(
          exported.files.map((entry) => [entry.path, entry.executable === true]).toSorted(),
          [
            ["SKILL.md", false],
            ["scripts/go.sh", true],
          ],
        );
        yield* service.installSkill({
          instanceId: targetId,
          name: exported.name,
          files: exported.files,
          overwrite: false,
        });
        const mode = (entry: string) =>
          h.fs
            .stat(h.path.join(h.targetSkills, "run", entry))
            .pipe(Effect.map((info) => info.mode & 0o777));
        assert.equal(yield* mode("scripts/go.sh"), 0o755);
        assert.equal(yield* mode("SKILL.md"), 0o644);
        assert.equal(yield* mode(""), 0o755);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("leaves version-control folders out and validates names and paths on export", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const clean = yield* h.writeSkill("clean", {
        "SKILL.md": "body",
        ".git/config": "[core]",
        "nested/.hg/store": "x",
        "nested/keep.txt": "keep",
      });
      const badName = yield* h.writeSkill("bad name", { "SKILL.md": "body" });
      const badPath = yield* h.writeSkill("odd", { "SKILL.md": "body", "a:b.txt": "x" });
      const caseClash = yield* h.writeSkill("clash", {
        "SKILL.md": "body",
        "Notes.txt": "a",
        "notes.txt": "b",
      });

      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const exportReason = (skillPath: string) =>
          service.exportSkill({ instanceId: sourceId, skillPath }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );
        const exported = yield* service.exportSkill({ instanceId: sourceId, skillPath: clean });
        assert.deepEqual(exported.files.map((entry) => entry.path).toSorted(), [
          "SKILL.md",
          "nested/keep.txt",
        ]);
        assert.equal(yield* exportReason(badName), "invalidName");
        const oddName = yield* service
          .exportSkill({ instanceId: sourceId, skillPath: badPath })
          .pipe(Effect.flip);
        assert.equal(oddName.reason, "invalidPath");
        assert.equal(oddName.path, "a:b.txt");
        assert.include(oddName.message, "a:b.txt");
        // A case-sensitive disk can hold both; the target may not, so export refuses early.
        const fsIsCaseSensitive =
          (yield* h.fs.readDirectory(h.path.join(h.sourceSkills, "clash"))).length === 3;
        if (fsIsCaseSensitive) assert.equal(yield* exportReason(caseClash), "invalidPath");
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("rejects malformed base64 and paths that differ only by case on install", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const attempt = (files: ReadonlyArray<ProviderSkillFile>) =>
          service
            .installSkill({ instanceId: targetId, name: "strict", files, overwrite: true })
            .pipe(Effect.flip);
        for (const bad of ["not base64!", "QUJD=", "QU=JD", "QUJDR", "QUJD\nRA=="]) {
          const result = yield* attempt([
            file("SKILL.md"),
            { path: "data.bin", contentBase64: bad },
          ]);
          assert.equal(result.reason, "invalidContent", bad);
        }
        assert.equal(
          (yield* attempt([file("SKILL.md"), file("A.txt"), file("a.txt")])).reason,
          "invalidPath",
        );
        assert.isFalse(yield* h.fs.exists(h.targetSkills));

        const ok = yield* service.installSkill({
          instanceId: targetId,
          name: "strict",
          files: [file("SKILL.md"), { path: "empty.txt", contentBase64: "" }],
          overwrite: true,
        });
        assert.equal(ok.fileCount, 2);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "turns a listed skill off through its instance and refreshes the accounts on its home",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.reported.push({ name: "plan", path: "/skills/plan/SKILL.md" });
        yield* Effect.gen(function* () {
          const service = yield* ProviderSkills.ProviderSkills;
          yield* service.setSkillEnabled({
            instanceId: sourceId,
            skillPath: "/skills/plan/SKILL.md",
            enabled: false,
          });
          assert.deepEqual(h.toggled, [
            { name: "plan", path: "/skills/plan/SKILL.md", enabled: false },
          ]);
          assert.sameMembers(
            [
              yield* Queue.take(h.refreshed),
              yield* Queue.take(h.refreshed),
              yield* Queue.take(h.refreshed),
            ],
            [sourceId, targetId, bareId],
          );
        }).pipe(Effect.provide(h.layer));
      }),
  );

  it.effect("fails when a project settings file keeps the skill in its old state", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.reported.push({ name: "plan", path: "/skills/plan/SKILL.md", enabled: true });
      h.pinned.add("/skills/plan/SKILL.md");
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        const failure = yield* service
          .setSkillEnabled({
            instanceId: sourceId,
            skillPath: "/skills/plan/SKILL.md",
            enabled: false,
          })
          .pipe(Effect.flip);
        assert.equal(failure.reason, "overriddenByProject");
        assert.equal(
          failure.message,
          "This skill is set in the project's settings, so the user setting has no effect.",
        );
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect("succeeds without the project-override check when the refresh fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.reported.push({ name: "plan", path: "/skills/plan/SKILL.md", enabled: true });
      h.pinned.add("/skills/plan/SKILL.md");
      h.refresh.fails = true;
      yield* Effect.gen(function* () {
        const service = yield* ProviderSkills.ProviderSkills;
        yield* service.setSkillEnabled({
          instanceId: sourceId,
          skillPath: "/skills/plan/SKILL.md",
          enabled: false,
        });
        assert.lengthOf(h.toggled, 1);
      }).pipe(Effect.provide(h.layer));
    }),
  );

  it.effect(
    "refuses to toggle unlisted skills, unknown instances, and providers without a switch",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.reported.push({ name: "plan", path: "/skills/plan/SKILL.md" });
        yield* Effect.gen(function* () {
          const service = yield* ProviderSkills.ProviderSkills;
          const reason = (instanceId: ProviderInstanceId, skillPath: string) =>
            service.setSkillEnabled({ instanceId, skillPath, enabled: false }).pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            );
          assert.equal(yield* reason(sourceId, "/etc/passwd"), "skillNotFound");
          assert.equal(yield* reason(targetId, "/skills/plan/SKILL.md"), "unsupported");
          assert.equal(
            yield* reason(ProviderInstanceId.make("gone"), "/skills/plan/SKILL.md"),
            "instanceNotFound",
          );
          assert.deepEqual(h.toggled, []);
        }).pipe(Effect.provide(h.layer));
      }),
  );
});
