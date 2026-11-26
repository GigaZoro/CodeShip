import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/** One root step allows every sandbox T3.CodeShip runs, so the operator runs sudo once. */
export const SETUP_SUBCOMMAND = "browser setup";

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

export interface UserNamespaceProfile {
  /** Who runs in the sandbox, as a sentence subject. */
  readonly subject: string;
  readonly path: string;
  readonly text: string;
}

/** Match Ubuntu's Chrome profile; unconfined adds nothing beyond userns. */
const userNamespaceProfile = (input: {
  readonly name: string;
  readonly attachment: string;
  readonly subject: string;
  readonly purpose: string;
}): UserNamespaceProfile => ({
  subject: input.subject,
  path: `/etc/apparmor.d/${input.name}`,
  text: `# Written by \`t3 ${SETUP_SUBCOMMAND}\`: ${input.purpose}
abi <abi/4.0>,
include <tunables/global>

profile ${input.name} ${input.attachment} flags=(unconfined) {
  userns,

  include if exists <local/${input.name}>
}
`,
});

export const BROWSER_PROFILE = userNamespaceProfile({
  name: "t3-chrome-headless-shell",
  attachment: "/**/tools/chrome-headless-shell/*/*/chrome-headless-shell",
  subject: "T3.CodeShip's browser",
  purpose: "lets T3.CodeShip's headless browser use Chrome's sandbox.",
});

/**
 * Codex verifies the bundled bwrap's digest and then execs it through /proc/self/fd,
 * which AppArmor attaches by the file's real path.
 */
export const CODEX_METADATA_PROFILE = userNamespaceProfile({
  name: "t3-codex-metadata-bwrap",
  attachment: "/**/codex-metadata/codex-resources/bwrap",
  subject: "Codex metadata requests",
  purpose:
    "lets the bundled bubblewrap of T3.CodeShip's Codex metadata runtime create its sandbox.",
});

export const PROFILES: ReadonlyArray<UserNamespaceProfile> = [
  BROWSER_PROFILE,
  CODEX_METADATA_PROFILE,
];

export const usernsRestricted = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
});

/** The host restricts unprivileged user namespaces and has not installed this profile. */
export const profileMissing = Effect.fn("hostSandboxProfiles.profileMissing")(function* (
  profile: UserNamespaceProfile,
) {
  if (!(yield* usernsRestricted)) return false;
  const fs = yield* FileSystem.FileSystem;
  return !(yield* fs.exists(profile.path).pipe(Effect.orElseSucceed(() => false)));
});
