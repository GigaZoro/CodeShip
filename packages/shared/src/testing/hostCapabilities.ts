import {
  decodeHostCapabilities,
  hostCapabilitiesVariable,
  probeHostCapabilities,
} from "./hostCapabilityProbe.ts";

const passed = process.env[hostCapabilitiesVariable];

/**
 * Every host capability a test skips without. `check:changed` probes them once, keys cached test
 * results on them and passes them to its tests, so a pass that skipped a test is not replayed once
 * the host gains what the test needs.
 */
export const hostCapabilities =
  passed === undefined ? await probeHostCapabilities() : decodeHostCapabilities(passed);

/** Whether a server can listen on the IPv6 loopback, which some CI hosts switch off. */
export const ipv6LoopbackSupported = hostCapabilities.ipv6Loopback;
