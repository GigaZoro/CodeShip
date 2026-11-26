import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostSandboxProfiles from "../hostSandboxProfiles.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";
import { resolveRootCliCommand } from "./invocation.ts";

export class BrowserSetupStepError extends Schema.TaggedError<BrowserSetupStepError>()(
  "BrowserSetupStepError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.step}: ${this.detail}`;
  }
}

const runStep = Effect.fn("browserSetup.runStep")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
    )
    .pipe(Effect.mapError((cause) => new BrowserSetupStepError({ step, detail: String(cause) })));
  if (exitCode !== 0) {
    return yield* new BrowserSetupStepError({ step, detail: `${command} exited with ${exitCode}` });
  }
});

/** Under sudo, an unspecified home uses the invoking user's ~/.t3. */
const setupBaseDir = Effect.fn("browserSetup.baseDir")(function* (explicit: Option.Option<string>) {
  const env = yield* HostProcess.Environment;
  const raw = Option.getOrUndefined(explicit) ?? env.T3CODE_HOME;
  if (raw !== undefined || env.SUDO_USER === undefined) return yield* resolveBaseDir(raw);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const entry = yield* spawner
    .string(
      ChildProcess.make("getent", ["passwd", env.SUDO_USER], { stdin: "ignore", stderr: "ignore" }),
    )
    .pipe(Effect.orElseSucceed(() => ""));
  const home = entry.trim().split(":")[5];
  const path = yield* Path.Path;
  return home ? path.join(home, ".t3") : yield* resolveBaseDir(undefined);
});

const aptOffers = Effect.fn("browserSetup.aptOffers")(function* (name: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const policy = yield* spawner
    .string(ChildProcess.make("apt-cache", ["policy", name], { stdin: "ignore", stderr: "ignore" }))
    .pipe(Effect.orElseSucceed(() => ""));
  const candidate = /Candidate:\s*(\S+)/.exec(policy)?.[1];
  return candidate !== undefined && candidate !== "(none)";
});

const installedBrowser = Effect.fn("browserSetup.installedBrowser")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(baseDir, "tools", "chrome-headless-shell");
  for (const platform of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    for (const version of yield* fs
      .readDirectory(path.join(root, platform))
      .pipe(Effect.orElseSucceed(() => []))) {
      const executable = path.join(root, platform, version, "chrome-headless-shell");
      if (yield* fs.exists(executable).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(executable);
      }
    }
  }
  return Option.none<string>();
});

/**
 * Chrome starts without fonts, but pages then render no text. Without
 * fontconfig there is no `fc-match` at all, which counts as no font.
 */
const fontAvailable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const font = yield* spawner
    .string(
      ChildProcess.make("fc-match", ["--format=%{file}", "sans-serif"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => ""),
    );
  return font.trim() !== "";
}).pipe(Effect.withSpan("browserSetup.fontAvailable"));

const FONT_PACKAGES = ["fontconfig", "fonts-liberation"];

const browserSetupCommand = Command.make("setup", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Set up this Linux host for T3.CodeShip's browser and Codex metadata requests: allow their sandboxes and install the browser's libraries and fonts.",
  ),
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") {
        return yield* Console.log(
          "Nothing to set up: T3.CodeShip's browser and Codex metadata requests run as is on this system.",
        );
      }
      const fs = yield* FileSystem.FileSystem;
      const isRoot = (yield* HostProcess.UserId) === 0;
      const env = yield* HostProcess.Environment;
      const baseDirPath = yield* setupBaseDir(baseDir);
      // sudo resets the environment, so a chosen home has to be on the command line.
      const setupCommand = yield* resolveRootCliCommand(
        HostSandboxProfiles.SETUP_SUBCOMMAND,
        Option.isSome(baseDir) || env.T3CODE_HOME !== undefined ? ["--base-dir", baseDirPath] : [],
      );
      // Root, unless sudo came from another user, is likely the server's own account.
      const rootWarning =
        isRoot && (env.SUDO_USER ?? "root") === "root" && !PreviewBrowserHost.sandboxDisabled(env)
          ? new PreviewBrowserHost.PreviewBrowserRootError().message
          : undefined;

      const restricted = yield* HostSandboxProfiles.usernsRestricted;
      const missingProfiles =
        restricted && isRoot
          ? HostSandboxProfiles.PROFILES
          : yield* Effect.filter(HostSandboxProfiles.PROFILES, HostSandboxProfiles.profileMissing);
      const reloadHint =
        restricted && !isRoot
          ? `\nIf the sandbox is still blocked, reload the installed profiles with:\n\n  ${setupCommand}\n`
          : "";
      const browser = yield* installedBrowser(baseDirPath);
      const missing = Option.isSome(browser)
        ? yield* PreviewBrowserHost.missingLibraries(browser.value)
        : [];
      const needsFonts = !(yield* fontAvailable);
      const hasApt = yield* fs.exists("/usr/bin/apt-get").pipe(Effect.orElseSucceed(() => false));

      if (missingProfiles.length === 0 && missing.length === 0 && !needsFonts) {
        return yield* Console.log(
          rootWarning ??
            (Option.isSome(browser)
              ? "This host is ready for T3.CodeShip's browser."
              : "Chrome's sandbox is allowed here. T3.CodeShip's browser installs on first use; if it then reports missing libraries, run this again.") +
              reloadHint,
        );
      }

      if (!isRoot) {
        for (const profile of missingProfiles) {
          yield* Console.log(
            `This host blocks the sandbox for ${profile.subject}. Setup installs an AppArmor profile at ${profile.path} that allows it.`,
          );
        }
        if (missing.length > 0) {
          yield* Console.log(
            `T3.CodeShip's browser is missing ${missing.join(", ")}; setup installs them.`,
          );
        }
        if (needsFonts) {
          yield* Console.log(
            "T3.CodeShip's browser needs fontconfig and system fonts; setup installs them.",
          );
        }
        return yield* Console.log(`\nThis needs root. Run:\n\n  ${setupCommand}\n`);
      }

      for (const profile of missingProfiles) {
        const onDisk = yield* fs.exists(profile.path).pipe(Effect.orElseSucceed(() => false));
        if (!onDisk)
          yield* fs
            .writeFileString(profile.path, profile.text)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserSetupStepError({
                    step: `write ${profile.path}`,
                    detail: cause.message,
                  }),
              ),
            );
        yield* runStep("load the AppArmor profile", "apparmor_parser", ["-r", profile.path]);
        yield* Console.log(
          `${onDisk ? "Reloaded the AppArmor profile" : "Wrote and loaded the AppArmor profile"} at ${profile.path} for ${profile.subject}.`,
        );
      }

      if ((missing.length > 0 || needsFonts) && !hasApt) {
        if (missing.length > 0) {
          yield* Console.log(
            `T3.CodeShip's browser is missing ${missing.join(", ")}. Install them with your package manager, then run this again.`,
          );
        }
        if (needsFonts) {
          yield* Console.log(
            "T3.CodeShip's browser needs fontconfig and system fonts. Install them with your package manager, then run this again.",
          );
        }
        return;
      }
      if (missing.length > 0 || needsFonts) {
        yield* runStep("refresh the package lists", "apt-get", ["update"]);
      }

      if (missing.length > 0) {
        const packages = yield* Effect.forEach(PreviewBrowserHost.DEBIAN_PACKAGES, (names) =>
          Effect.findFirst(names, aptOffers).pipe(Effect.map(Option.getOrElse(() => names[0]!))),
        );
        yield* runStep("install the browser's libraries", "apt-get", [
          "install",
          "-y",
          "--no-install-recommends",
          ...packages,
        ]);
        yield* Console.log("Installed the browser's libraries.");
      }

      if (needsFonts) {
        yield* runStep("install the browser's fonts", "apt-get", [
          "install",
          "-y",
          "--no-install-recommends",
          ...FONT_PACKAGES,
        ]);
        if (!(yield* fontAvailable)) {
          return yield* Console.log(
            "Font packages are installed, but Fontconfig still finds no system font. Check its configuration and run setup again.",
          );
        }
        yield* Console.log(
          "Installed the browser's fonts. Restart the T3.CodeShip server if browser tabs were already open.",
        );
      }

      yield* Console.log(rootWarning ?? "This host is ready for T3.CodeShip's browser.");
    }),
  ),
);

export const browserCommand = Command.make("browser").pipe(
  Command.withDescription("Manage T3.CodeShip's headless browser on this host."),
  Command.withSubcommands([browserSetupCommand]),
);
