const fs = require("node:fs");
const path = require("node:path");

// electron-builder drops Electron's sample app only from a zip it downloaded itself. Packaging
// unpacks the staged zip instead (electronDist), so this repeats that cleanup and ships the same files.
module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  const resources =
    electronPlatformName === "darwin" || electronPlatformName === "mas"
      ? path.join(appOutDir, packager.info.framework.distMacOsAppName, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  fs.rmSync(path.join(resources, "default_app.asar"));
  fs.rmSync(path.join(appOutDir, "version"));
};
