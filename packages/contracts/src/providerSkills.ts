import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const PROVIDER_SKILL_MAX_FILES = 200;
export const PROVIDER_SKILL_MAX_BYTES = 5 * 1024 * 1024;

/** A file inside a skill folder; `path` is relative to the folder and uses forward slashes. */
export const ProviderSkillFile = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  contentBase64: Schema.String,
  /** Set when the file had an execute bit on the source machine. */
  executable: Schema.optionalKey(Schema.Boolean),
});
export type ProviderSkillFile = typeof ProviderSkillFile.Type;

export const ProviderSkillExportInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** The `path` of a skill in the provider's skills list: its SKILL.md. */
  skillPath: TrimmedNonEmptyString,
});
export type ProviderSkillExportInput = typeof ProviderSkillExportInput.Type;

export const ProviderSkillExportResult = Schema.Struct({
  /** The skill's folder name, which is the name it installs under. */
  name: TrimmedNonEmptyString,
  files: Schema.Array(ProviderSkillFile),
  /** Links inside the skill that were left out because they point outside it or are broken. */
  skippedLinks: Schema.optionalKey(NonNegativeInt),
});
export type ProviderSkillExportResult = typeof ProviderSkillExportResult.Type;

export const ProviderSkillInstallInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: Schema.String,
  files: Schema.Array(ProviderSkillFile),
  overwrite: Schema.Boolean,
});
export type ProviderSkillInstallInput = typeof ProviderSkillInstallInput.Type;

export const ProviderSkillInstallResult = Schema.Struct({
  name: TrimmedNonEmptyString,
  fileCount: NonNegativeInt,
});
export type ProviderSkillInstallResult = typeof ProviderSkillInstallResult.Type;

export const ProviderSkillSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** The `path` of a skill in the provider's skills list: its SKILL.md. */
  skillPath: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type ProviderSkillSetEnabledInput = typeof ProviderSkillSetEnabledInput.Type;

export const ProviderSkillOperation = Schema.Literals(["export", "install", "setEnabled"]);
export type ProviderSkillOperation = typeof ProviderSkillOperation.Type;

export const ProviderSkillErrorReason = Schema.Literals([
  "instanceNotFound",
  "unsupported",
  "skillNotFound",
  "invalidName",
  "invalidPath",
  "invalidContent",
  "linkedSkill",
  "missingSkillFile",
  "tooManyFiles",
  "tooLarge",
  "alreadyExists",
  "overriddenByProject",
  "failed",
]);
export type ProviderSkillErrorReason = typeof ProviderSkillErrorReason.Type;

export class ProviderSkillError extends Schema.TaggedError<ProviderSkillError>()(
  "ProviderSkillError",
  {
    operation: ProviderSkillOperation,
    instanceId: ProviderInstanceId,
    reason: ProviderSkillErrorReason,
    /** For `linkedSkill`: the real folder of the skill (export) or of the skills directory (install). */
    linkTarget: Schema.optionalKey(Schema.String),
    /** For `invalidPath`: the offending path relative to the skill folder. */
    path: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "instanceNotFound":
        return "This provider is no longer configured.";
      case "unsupported":
        return this.operation === "setEnabled"
          ? "This skill cannot be turned on or off here."
          : "This provider does not support copying skills.";
      case "skillNotFound":
        return "This skill is not in the provider's skills list.";
      case "invalidName":
        return "The skill name is not allowed.";
      case "invalidPath":
        return this.path === undefined
          ? "The skill contains a file path that is not allowed."
          : `The skill contains a file path that is not allowed: ${this.path}`;
      case "invalidContent":
        return "The skill contains a file that is not valid base64.";
      case "linkedSkill":
        return this.operation === "export"
          ? "This skill is a link, or lives in a git repository, so that repository manages it."
          : "This machine's skills are a link or live in a git repository, so nothing was written.";
      case "missingSkillFile":
        return "The skill has no SKILL.md.";
      case "tooManyFiles":
        return `The skill has more than ${PROVIDER_SKILL_MAX_FILES} files.`;
      case "tooLarge":
        return "The skill is larger than 5 MB.";
      case "alreadyExists":
        return "A skill with this name already exists.";
      case "overriddenByProject":
        return "This skill is set in the project's settings, so the user setting has no effect.";
      case "failed":
        switch (this.operation) {
          case "export":
            return "Could not read the skill.";
          case "install":
            return "Could not install the skill.";
          case "setEnabled":
            return "Could not change whether the skill is enabled.";
        }
    }
  }
}
