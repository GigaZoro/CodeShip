import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts/providerInstance";
import type { ServerProvider } from "@t3tools/contracts/server";
import type * as Stream from "effect/Stream";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

export type ProviderSnapshotSource = {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly getSnapshot: ManagedServerProvider["getSnapshot"];
  readonly refresh: ManagedServerProvider["refresh"];
  readonly streamChanges: Stream.Stream<ServerProvider>;
  readonly supportsPlugins?: boolean;
  readonly supportsMcpServers?: boolean;
  readonly supportsSkillInstall?: boolean;
  readonly supportsSkillToggle?: boolean;
  readonly sharesAddedAccounts?: boolean;
};
