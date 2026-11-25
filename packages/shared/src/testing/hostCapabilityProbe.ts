// @effect-diagnostics nodeBuiltinImport:off - probes outside any Effect runtime, as tests load.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

// It matches the `T3_TEST_*` variables that `check:changed` tracks.
export const hostCapabilitiesVariable = "T3_TEST_HOST_CAPABILITIES";

const HostCapabilitiesJson = Schema.fromJsonString(
  Schema.Struct({ symlinks: Schema.Boolean, ipv6Loopback: Schema.Boolean }),
);
const encodeHostCapabilities = Schema.encodeSync(HostCapabilitiesJson);
export const decodeHostCapabilities = Schema.decodeSync(HostCapabilitiesJson);

function probeSymlinks() {
  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-symlink-probe-"));
    NodeFS.symlinkSync(NodePath.join(directory, "target"), NodePath.join(directory, "link"));
    return true;
  } catch {
    return false;
  } finally {
    // Cleanup EPERM/EBUSY must not fail module initialization or decide symlink support.
    try {
      if (directory !== undefined) NodeFS.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
}

const probeIpv6Loopback = () =>
  new Promise<boolean>((resolve) => {
    const probe = NodeNet.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });

/**
 * Probes this host. `check:changed` imports this module rather than `hostCapabilities.ts`, so a
 * value an outer run passed down, well-formed or not, never reaches its probe.
 */
export const probeHostCapabilities = async () => ({
  symlinks: probeSymlinks(),
  ipv6Loopback: await probeIpv6Loopback(),
});

/**
 * The variable through which `check:changed` gives its tests the capabilities its cached results
 * are keyed on, so they skip by those values rather than by a later probe.
 */
export const hostCapabilitiesEnv = (capabilities: typeof HostCapabilitiesJson.Type) => ({
  [hostCapabilitiesVariable]: encodeHostCapabilities(capabilities),
});
