// @effect-diagnostics globalConsole:off - A maintainer script that prints one line per build.

import {
  generateThirdPartyLicenseManifest,
  shippedThirdPartyLicenses,
} from "./lib/third-party-licenses.ts";

// The web and mobile builds stop on a dependency without a notice; this finds one without a build.
await Promise.all(
  Object.entries(shippedThirdPartyLicenses(new URL("../", import.meta.url))).map(
    ([build, inputs]) =>
      generateThirdPartyLicenseManifest(inputs).then(
        (manifest) =>
          console.log(`${build}: ${String(manifest.entries.length)} third-party notices`),
        (error: unknown) => {
          process.exitCode = 1;
          console.error(`${build}: ${error instanceof Error ? error.message : String(error)}`);
        },
      ),
  ),
);
