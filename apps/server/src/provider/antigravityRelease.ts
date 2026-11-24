import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const ANTIGRAVITY_RELEASE_VERSION = "1.5.2";
export const ANTIGRAVITY_REGISTRY_ENTRY =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json";
const MAX_REGISTRY_ENTRY_BYTES = 16 * 1024;
const StableVersion = Schema.String.check(Schema.isPattern(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u));
const RegistryEntry = Schema.Struct({
  id: Schema.Literal("antigravity-acp"),
  version: StableVersion,
  distribution: Schema.Struct({
    binary: Schema.Record(
      Schema.String,
      Schema.Struct({
        archive: Schema.String,
        cmd: Schema.String,
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      }),
    ),
  }),
});
const decodeRegistryEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(RegistryEntry));

export interface AntigravityDownload {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

export interface AntigravityReleaseAsset extends AntigravityDownload {
  readonly archiveBytes: number;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
  readonly harness: {
    readonly name: string;
    readonly bytes: number;
  };
}

const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-arm64.zip",
      sha256: "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845",
      archiveBytes: 100_309_778,
      executable: { name: "agy_acp_server.par", bytes: 179_921_328 },
      harness: { name: "localharness_external", bytes: 129_208_672 },
    },
  ],
  [
    "darwin-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.5.2-darwin-x86_64.zip",
      sha256: "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06",
      archiveBytes: 106_351_992,
      executable: { name: "agy_acp_server.par", bytes: 184_312_784 },
      harness: { name: "localharness_external", bytes: 134_350_320 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip",
      sha256: "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852",
      archiveBytes: 273_964_075,
      executable: { name: "agy_acp_server.par", bytes: 714_384_320 },
      harness: { name: "localharness_external", bytes: 139_194_456 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-arm64.zip",
      sha256: "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb",
      archiveBytes: 264_270_419,
      executable: { name: "agy_acp_server.par", bytes: 721_649_155 },
      harness: { name: "localharness_external", bytes: 132_598_576 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-x86_64.zip",
      sha256: "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6",
      archiveBytes: 105_407_645,
      executable: { name: "agy_acp_server.exe", bytes: 58_368_800 },
      harness: { name: "localharness_external.exe", bytes: 155_357_336 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.5.2-windows-arm64.zip",
      sha256: "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab",
      archiveBytes: 108_049_351,
      executable: { name: "agy_acp_server.exe", bytes: 65_130_848 },
      harness: { name: "localharness_external.exe", bytes: 146_707_096 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}

export const discoverAntigravityRelease = Effect.fn("AntigravityRelease.discover")(function* (
  platform: NodeJS.Platform,
  arch: string,
) {
  const pinned = resolveAntigravityReleaseAsset(platform, arch);
  if (!pinned) return null;
  const registryPlatform = platform === "win32" ? "windows" : platform;
  const registryArch = arch === "arm64" ? "aarch64" : "x86_64";
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(HttpClientRequest.get(ANTIGRAVITY_REGISTRY_ENTRY))
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
  const body = yield* collectUint8StreamText({
    stream: response.stream,
    maxBytes: MAX_REGISTRY_ENTRY_BYTES,
  });
  if (body.truncated || body.invalidUtf8) return null;
  const release = yield* decodeRegistryEntry(body.text);
  const binary = release.distribution.binary[`${registryPlatform}-${registryArch}`];
  const expectedUrl = pinned.url.replace(pinned.version, release.version);
  if (!binary || binary.archive !== expectedUrl || binary.cmd !== `./${pinned.executable.name}`) {
    return null;
  }
  return {
    version: release.version,
    url: expectedUrl,
    sha256: binary.sha256,
  } satisfies AntigravityDownload;
}, Effect.timeout("5 seconds"));
