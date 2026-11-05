import {
  PROVIDER_SKILL_MAX_BYTES,
  PROVIDER_SKILL_MAX_FILES,
  ProviderSkillError,
  type ProviderInstanceId,
  type ProviderSkillErrorReason,
  type ProviderSkillExportInput,
  type ProviderSkillExportResult,
  type ProviderSkillFile,
  type ProviderSkillInstallInput,
  type ProviderSkillInstallResult,
  type ProviderSkillOperation,
  type ProviderSkillSetEnabledInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const SKILL_FILE = "SKILL.md";
const MAX_BASE64_LENGTH = Math.ceil((PROVIDER_SKILL_MAX_BYTES * 4) / 3) + 4;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Finder litter is never part of a skill, and copying it would only add noise on the target.
const IGNORED_ENTRIES = new Set([".DS_Store"]);
// Version-control metadata is history of the source machine, not part of the skill.
const VCS_DIRECTORIES = new Set([".git", ".hg", ".svn"]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;

const hasControlCharacter = (value: string) => {
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20) return true;
  }
  return false;
};

const isSafeRelativePath = (value: string) =>
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes(":") &&
  !hasControlCharacter(value) &&
  value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");

export class ProviderSkills extends Context.Service<
  ProviderSkills,
  {
    readonly exportSkill: (
      input: ProviderSkillExportInput,
    ) => Effect.Effect<ProviderSkillExportResult, ProviderSkillError>;
    readonly installSkill: (
      input: ProviderSkillInstallInput,
    ) => Effect.Effect<ProviderSkillInstallResult, ProviderSkillError>;
    readonly setSkillEnabled: (
      input: ProviderSkillSetEnabledInput,
    ) => Effect.Effect<void, ProviderSkillError>;
  }
>()("t3/provider/ProviderSkills") {}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const scope = yield* Effect.scope;

  const fail = (
    operation: ProviderSkillOperation,
    instanceId: ProviderInstanceId,
    reason: ProviderSkillErrorReason,
    extra?: {
      readonly cause?: unknown;
      readonly linkTarget?: string;
      readonly path?: string;
    },
  ) =>
    new ProviderSkillError({
      operation,
      instanceId,
      reason,
      ...(extra?.cause === undefined ? {} : { cause: extra.cause }),
      ...(extra?.linkTarget === undefined ? {} : { linkTarget: extra.linkTarget }),
      ...(extra?.path === undefined ? {} : { path: extra.path }),
    });

  const getInstance = Effect.fn("ProviderSkills.getInstance")(function* (
    operation: ProviderSkillOperation,
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance === undefined) {
      return yield* fail(operation, instanceId, "instanceNotFound");
    }
    return instance;
  });

  const isSymbolicLink = (entry: string) =>
    fileSystem.readLink(entry).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const tooLarge = (operation: ProviderSkillOperation, instanceId: ProviderInstanceId) =>
    fail(operation, instanceId, "tooLarge");

  const isInsideGitRepository = Effect.fn("ProviderSkills.isInsideGitRepository")(function* (
    directory: string,
  ) {
    // A dotfiles repository at the home folder would otherwise make every skill look managed, so
    // the walk stops short of home; a repository below it, such as ~/.agents, still counts.
    const realHome = yield* fileSystem.realPath(home).pipe(Effect.orElseSucceed(() => home));
    const underHome = directory === realHome || isInside(realHome, directory);
    let current = directory;
    // Bounded so a pathological path can never loop.
    for (let depth = 0; depth < 64; depth++) {
      if (underHome && current === realHome) return false;
      const hasGit = yield* fileSystem
        .exists(path.join(current, ".git"))
        .pipe(Effect.orElseSucceed(() => false));
      if (hasGit) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    return false;
  });

  const isInside = (root: string, candidate: string) =>
    candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

  /**
   * Links that resolve inside the skill are followed, so their contents are copied. A link that
   * leaves the skill, is broken, or loops cannot be copied faithfully and is counted instead.
   */
  const collectFiles = Effect.fn("ProviderSkills.collectFiles")(function* (
    instanceId: ProviderInstanceId,
    root: string,
  ) {
    const realRoot = yield* fileSystem.realPath(root);
    const files: Array<{
      readonly relativePath: string;
      readonly source: string;
      readonly executable: boolean;
    }> = [];
    const seenPaths = new Set<string>();
    let skippedLinks = 0;
    let totalBytes = 0;
    const pending = [{ relativeDirectory: "", realDirectory: realRoot, ancestors: [realRoot] }];
    while (pending.length > 0) {
      const { relativeDirectory, realDirectory, ancestors } = pending.pop()!;
      const entries = yield* fileSystem.readDirectory(realDirectory);
      for (const entry of entries.toSorted()) {
        if (IGNORED_ENTRIES.has(entry) || VCS_DIRECTORIES.has(entry)) continue;
        const relativePath = relativeDirectory === "" ? entry : `${relativeDirectory}/${entry}`;
        if (!isSafeRelativePath(relativePath) || seenPaths.has(relativePath.toLowerCase())) {
          return yield* fail("export", instanceId, "invalidPath", { path: relativePath });
        }
        seenPaths.add(relativePath.toLowerCase());
        const entryPath = path.join(realDirectory, entry);
        const linked = yield* isSymbolicLink(entryPath);
        const resolved = linked
          ? yield* fileSystem.realPath(entryPath).pipe(Effect.orElseSucceed(() => null))
          : entryPath;
        if (resolved === null || (linked && !isInside(realRoot, resolved))) {
          skippedLinks += 1;
          continue;
        }
        const info = yield* fileSystem.stat(resolved);
        if (info.type === "Directory") {
          // A link back to a directory above it would never end.
          if (ancestors.includes(resolved)) {
            skippedLinks += 1;
            continue;
          }
          pending.push({
            relativeDirectory: relativePath,
            realDirectory: resolved,
            ancestors: [...ancestors, resolved],
          });
        } else if (info.type === "File") {
          totalBytes += Number(info.size);
          if (files.length >= PROVIDER_SKILL_MAX_FILES) {
            return yield* fail("export", instanceId, "tooManyFiles");
          }
          if (totalBytes > PROVIDER_SKILL_MAX_BYTES) return yield* tooLarge("export", instanceId);
          files.push({
            relativePath,
            source: resolved,
            executable: (info.mode & 0o111) !== 0,
          });
        }
      }
    }
    return { files, skippedLinks };
  });

  const exportSkill = Effect.fn("ProviderSkills.exportSkill")(function* (
    input: ProviderSkillExportInput,
  ) {
    const { instanceId } = input;
    yield* Effect.annotateCurrentSpan({ "provider.instance_id": instanceId });
    yield* getInstance("export", instanceId);
    const snapshots = yield* providers.getProviders;
    const known = snapshots
      .filter((provider) => provider.instanceId === instanceId)
      .some((provider) =>
        [provider.skills, ...(provider.workspaceSnapshots ?? []).map((entry) => entry.skills)].some(
          (skills) => skills.some((skill) => skill.path === input.skillPath),
        ),
      );
    // Only paths the provider itself reported are skills; anything else could be any file.
    if (!known || path.basename(input.skillPath) !== SKILL_FILE) {
      return yield* fail("export", instanceId, "skillNotFound");
    }
    const directory = path.dirname(input.skillPath);
    const name = path.basename(directory);
    if (!SKILL_NAME_PATTERN.test(name)) return yield* fail("export", instanceId, "invalidName");
    // A linked skill, or one inside a larger git repository such as an agent-config clone, belongs
    // to whatever manages it; a copy on another machine would drift from it unmanaged. A skill that
    // is its own checkout copies as a snapshot, without its .git.
    const realDirectory = yield* fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => directory));
    if (
      (yield* isSymbolicLink(directory)) ||
      (yield* isInsideGitRepository(path.dirname(realDirectory)))
    ) {
      return yield* fail("export", instanceId, "linkedSkill", { linkTarget: realDirectory });
    }
    const { files, skippedLinks } = yield* collectFiles(instanceId, directory).pipe(
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(fail("export", instanceId, "failed", { cause })),
      }),
    );
    if (!files.some((file) => file.relativePath === SKILL_FILE)) {
      return yield* fail("export", instanceId, "skillNotFound");
    }
    const contents = yield* Effect.forEach(files, (file) =>
      fileSystem.readFile(file.source).pipe(
        Effect.map((bytes): ProviderSkillFile => ({
          path: file.relativePath,
          contentBase64: Buffer.from(bytes).toString("base64"),
          ...(file.executable ? { executable: true } : {}),
        })),
      ),
    ).pipe(
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(fail("export", instanceId, "failed", { cause })),
      }),
    );
    return {
      name,
      files: contents,
      ...(skippedLinks > 0 ? { skippedLinks } : {}),
    } satisfies ProviderSkillExportResult;
  });

  const decodeFiles = Effect.fn("ProviderSkills.decodeFiles")(function* (
    instanceId: ProviderInstanceId,
    files: ProviderSkillInstallInput["files"],
  ) {
    if (files.length > PROVIDER_SKILL_MAX_FILES) {
      return yield* fail("install", instanceId, "tooManyFiles");
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    const decoded: Array<{
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly executable: boolean;
    }> = [];
    for (const file of files) {
      // Paths differing only by case collide on case-insensitive disks, so they count as duplicates.
      if (!isSafeRelativePath(file.path) || seen.has(file.path.toLowerCase())) {
        return yield* fail("install", instanceId, "invalidPath", { path: file.path });
      }
      seen.add(file.path.toLowerCase());
      // Base64 is 4 characters per 3 bytes, so oversized input fails before it is decoded.
      if (file.contentBase64.length > MAX_BASE64_LENGTH)
        return yield* tooLarge("install", instanceId);
      if (file.contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(file.contentBase64)) {
        return yield* fail("install", instanceId, "invalidContent");
      }
      const bytes = Buffer.from(file.contentBase64, "base64");
      totalBytes += bytes.byteLength;
      if (totalBytes > PROVIDER_SKILL_MAX_BYTES) return yield* tooLarge("install", instanceId);
      decoded.push({ path: file.path, bytes, executable: file.executable === true });
    }
    if (!files.some((file) => file.path === SKILL_FILE))
      return yield* fail("install", instanceId, "missingSkillFile");
    return decoded;
  });

  /** Writes beside the target and renames into place, so a failure never leaves half a skill. */
  const writeSkill = Effect.fn("ProviderSkills.writeSkill")(function* (input: {
    readonly skillsDirectory: string;
    readonly name: string;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly executable: boolean;
    }>;
    readonly overwrite: boolean;
    readonly instanceId: ProviderInstanceId;
  }) {
    const target = path.join(input.skillsDirectory, input.name);
    // Replacing a link would leave its target orphaned or write through it into a managed folder.
    if (yield* isSymbolicLink(target)) {
      return yield* fail("install", input.instanceId, "linkedSkill");
    }
    // Writing into a git checkout (a linked agent-config skills folder) would add unmanaged files.
    const realSkillsDirectory = yield* fileSystem
      .realPath(input.skillsDirectory)
      .pipe(Effect.orElseSucceed(() => input.skillsDirectory));
    if (yield* isInsideGitRepository(realSkillsDirectory)) {
      return yield* fail("install", input.instanceId, "linkedSkill", {
        linkTarget: realSkillsDirectory,
      });
    }
    const exists = yield* fileSystem.exists(target);
    if (exists && !input.overwrite) {
      return yield* fail("install", input.instanceId, "alreadyExists");
    }
    yield* fileSystem.makeDirectory(input.skillsDirectory, { recursive: true });
    const staging = yield* fileSystem.makeTempDirectory({
      directory: input.skillsDirectory,
      prefix: ".codeship-skill-",
    });
    const backup = `${staging}-previous`;
    const publish = Effect.gen(function* () {
      for (const file of input.files) {
        const destination = path.join(staging, ...file.path.split("/"));
        yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fileSystem.writeFile(destination, file.bytes);
        // chmod rather than the write mode, which the umask would narrow.
        yield* fileSystem.chmod(destination, file.executable ? EXECUTABLE_MODE : FILE_MODE);
      }
      // The temp directory is created private; the installed skill must be readable like others.
      yield* fileSystem.chmod(staging, EXECUTABLE_MODE);
      const replacing = exists;
      if (replacing) yield* fileSystem.rename(target, backup);
      yield* fileSystem.rename(staging, target).pipe(
        Effect.onError(() =>
          replacing ? fileSystem.rename(backup, target).pipe(Effect.ignore) : Effect.void,
        ),
        // Someone else created the target after the check above; do not report it as a failure.
        Effect.catchTags({
          PlatformError: Effect.fn("ProviderSkills.publishRaced")(function* (cause) {
            const appeared =
              !replacing &&
              ((yield* isSymbolicLink(target)) ||
                (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))));
            return yield* appeared
              ? fail("install", input.instanceId, "alreadyExists", { cause })
              : Effect.fail(cause);
          }),
        }),
      );
      if (replacing) {
        yield* fileSystem.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore);
      }
    });
    yield* publish.pipe(
      Effect.ensuring(
        fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  });

  /** Accounts on one provider home read the same skills, so each picks up a change to them. */
  const refreshSharingHome = Effect.fn("ProviderSkills.refreshSharingHome")(function* (
    instanceId: ProviderInstanceId,
    refreshed?: ProviderInstanceId,
  ) {
    const sharing = ProviderInstanceRegistry.instancesSharingHome(
      yield* instances.listInstances,
      instanceId,
    ).filter((id) => id !== refreshed);
    yield* Effect.forEach(
      sharing,
      (id) =>
        // The provider refresh outlives the request, whose scope would interrupt it.
        providers.refreshInstance(id).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope)),
      { discard: true },
    );
  });

  const installSkill = Effect.fn("ProviderSkills.installSkill")(function* (
    input: ProviderSkillInstallInput,
  ) {
    const { instanceId } = input;
    yield* Effect.annotateCurrentSpan({ "provider.instance_id": instanceId });
    const instance = yield* getInstance("install", instanceId);
    if (instance.personalSkillsDirectory === undefined) {
      return yield* fail("install", instanceId, "unsupported");
    }
    if (!SKILL_NAME_PATTERN.test(input.name)) {
      return yield* fail("install", instanceId, "invalidName");
    }
    const files = yield* decodeFiles(instanceId, input.files);
    yield* writeSkill({
      skillsDirectory: instance.personalSkillsDirectory,
      name: input.name,
      files,
      overwrite: input.overwrite,
      instanceId,
    }).pipe(
      Effect.catchTags({
        PlatformError: (cause) => Effect.fail(fail("install", instanceId, "failed", { cause })),
      }),
    );
    yield* refreshSharingHome(instanceId);
    return { name: input.name, fileCount: files.length } satisfies ProviderSkillInstallResult;
  });

  const findReportedSkill = (instanceId: ProviderInstanceId, skillPath: string) =>
    providers.getProviders.pipe(
      Effect.map((snapshots) =>
        snapshots
          .flatMap((provider) =>
            provider.instanceId === instanceId
              ? [
                  ...provider.skills,
                  ...(provider.workspaceSnapshots ?? []).flatMap((entry) => entry.skills),
                ]
              : [],
          )
          .find((candidate) => candidate.path === skillPath),
      ),
    );

  const setSkillEnabled = Effect.fn("ProviderSkills.setSkillEnabled")(function* (
    input: ProviderSkillSetEnabledInput,
  ) {
    const { instanceId } = input;
    yield* Effect.annotateCurrentSpan({ "provider.instance_id": instanceId });
    const instance = yield* getInstance("setEnabled", instanceId);
    if (instance.setSkillEnabled === undefined) {
      return yield* fail("setEnabled", instanceId, "unsupported");
    }
    // Only paths the provider itself reported are skills; the name comes from that listing.
    const skill = yield* findReportedSkill(instanceId, input.skillPath);
    if (skill === undefined) return yield* fail("setEnabled", instanceId, "skillNotFound");
    yield* instance.setSkillEnabled({
      name: skill.name,
      path: skill.path,
      enabled: input.enabled,
    });
    // The list the caller sees is the instance's own snapshot, so it is current when this returns.
    yield* providers.refreshInstance(instanceId).pipe(Effect.ignoreCause({ log: true }));
    yield* refreshSharingHome(instanceId, instanceId);
    // A project or local settings file outranks the user setting that was just written.
    const refreshed = yield* findReportedSkill(instanceId, input.skillPath);
    if (refreshed !== undefined && refreshed.enabled !== input.enabled) {
      return yield* fail("setEnabled", instanceId, "overriddenByProject");
    }
  });

  return ProviderSkills.of({ exportSkill, installSkill, setSkillEnabled });
});

export const layer = Layer.effect(ProviderSkills, make);
