import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { BROWSER_PROFILE, CODEX_METADATA_PROFILE, PROFILES } from "../hostSandboxProfiles.ts";
import {
  SeaRequiresCodexMetadata,
  packagedMetadataSandboxProblem,
  resolvePackagedCodexMetadataBinary,
} from "./packagedCodexMetadata.ts";

it.effect("selects only the installed server's native metadata package", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const resolve = (sea: boolean, archive: string, platform: NodeJS.Platform, required: boolean) =>
      resolvePackagedCodexMetadataBinary(path.join(dir, archive, "apps/server/dist")).pipe(
        Effect.provideService(SeaRequiresCodexMetadata, required),
        Effect.provideService(HostProcess.IsExecutable, sea),
        Effect.provideService(HostProcess.ExecutablePath, path.join(dir, "t3")),
        Effect.provideService(HostProcess.Platform, platform),
      );
    assert.isUndefined(yield* resolve(true, "", "linux", false));
    assert.equal(
      yield* resolve(true, "", "linux", true),
      path.join(dir, "codex-metadata/bin/codex"),
    );
    for (const [archive, platform, executable] of [
      ["app.asar", "darwin", "codex"],
      ["server.asar", "win32", "codex.exe"],
    ] as const) {
      const dist = path.join(dir, archive, "apps/server/dist");
      yield* fs.makeDirectory(dist, { recursive: true });
      assert.isUndefined(yield* resolve(false, archive, platform, false));
      yield* fs.writeFileString(path.join(dist, "codex-metadata.files"), "required");
      assert.equal(
        yield* resolve(false, archive, platform, false),
        path.join(dir, "codex-metadata/bin", executable),
      );
    }
    assert.isUndefined(yield* resolve(false, "checkout", "linux", true));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses the verified Linux runtime or reports the mounted WSL installation needs repair",
  () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const mounted = path.join(dir, "wsl-server-tree", "1.2.3", "apps/server/dist");
      const runtime = path.join(dir, "linux-runtime");
      const resolve = (root?: string, moduleDirectory = mounted) =>
        resolvePackagedCodexMetadataBinary(moduleDirectory).pipe(
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.Environment, {
            T3CODE_WSL_CODEX_METADATA_RUNTIME_ROOT: root,
          }),
        );
      assert.isUndefined(yield* resolve());
      assert.isUndefined(yield* resolve(runtime, path.join(dir, "checkout/apps/server/dist")));
      assert.equal(yield* resolve(runtime), path.join(runtime, "codex-metadata/bin/codex"));
      for (const invalidRoot of ["", "relative/runtime"]) {
        const failure = yield* Effect.flip(resolve(invalidRoot));
        assert.match(String(failure), /Reinstall CodeShip.*Linux Codex metadata runtime.*WSL/);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("packagedMetadataSandboxProblem", () => {
  const BINARY = "/opt/t3/codex-metadata/bin/codex";
  it.effect.each([
    { label: "names the root setup step when AppArmor blocks bwrap", blocked: true },
    { label: "allows a host that does not restrict namespaces", restriction: "0\n" },
    { label: "allows a host with the profile", profile: true },
    { label: "skips hosts that are not Linux", platform: "darwin" as const },
    { label: "skips servers without the packaged runtime", binary: undefined },
  ])("$label", (input) =>
    Effect.gen(function* () {
      const problem = yield* packagedMetadataSandboxProblem(
        "binary" in input ? input.binary : BINARY,
      ).pipe(
        Effect.provide(
          Layer.merge(
            Path.layer,
            FileSystem.layerNoop({
              readFileString: (file) =>
                file === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
                  ? Effect.succeed(input.restriction ?? "1\n")
                  : Effect.die(`unexpected read of ${file}`),
              exists: (file) =>
                Effect.succeed(file === CODEX_METADATA_PROFILE.path && input.profile === true),
            }),
          ),
        ),
        Effect.provideService(HostProcess.Platform, input.platform ?? "linux"),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.ExecutablePath, "/opt/t3/t3"),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.equal(
        problem?.message,
        input.blocked
          ? "This host blocks the sandbox Codex metadata requests read the repository in (AppArmor on Ubuntu 23.10+), so titles, commit messages and other generated text are written without the repository. Run `sudo /opt/t3/t3 browser setup` on the host once to allow it."
          : undefined,
      );
    }),
  );
});

it("grants user namespaces to the bundled bwrap that Codex execs", () => {
  assert.equal(CODEX_METADATA_PROFILE.path, "/etc/apparmor.d/t3-codex-metadata-bwrap");
  assert.include(
    CODEX_METADATA_PROFILE.text,
    "profile t3-codex-metadata-bwrap /**/codex-metadata/codex-resources/bwrap flags=(unconfined) {\n  userns,\n",
  );
  assert.include(PROFILES, CODEX_METADATA_PROFILE);
  // Hosts set up before the metadata profile keep the browser profile byte for byte.
  assert.equal(
    BROWSER_PROFILE.text,
    `# Written by \`t3 browser setup\`: lets T3.CodeShip's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome-headless-shell>
}
`,
  );
});
