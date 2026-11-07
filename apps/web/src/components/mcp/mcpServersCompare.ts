import type { ProviderMcpServer } from "@t3tools/contracts";

/** Another machine's copy of the same provider; `servers` is null until its list answers. */
export interface McpPeerServers {
  readonly label: string;
  readonly servers: ReadonlyArray<ProviderMcpServer> | null;
}

export interface McpServerDifference {
  readonly label: string;
  readonly server: ProviderMcpServer;
}

export interface McpServerComparison {
  /** Machines whose same provider lacks this server. */
  readonly missingOn: ReadonlyArray<string>;
  /** Machines that have it with another address or command, or turned the other way. */
  readonly differentOn: ReadonlyArray<McpServerDifference>;
}

export interface McpServersComparison {
  readonly byName: ReadonlyMap<string, McpServerComparison>;
  /** Servers other machines have that this one lacks, with the machines that have each. */
  readonly onlyElsewhere: ReadonlyArray<{
    readonly name: string;
    readonly labels: ReadonlyArray<string>;
  }>;
}

const isOn = (server: ProviderMcpServer) => server.status !== "disabled";

/** Status like "needs sign-in" is the machine's own state; only what is set up is compared. */
const differs = (left: ProviderMcpServer, right: ProviderMcpServer) =>
  left.transport !== right.transport || left.target !== right.target || isOn(left) !== isOn(right);

/** A machine whose list has not answered is left out rather than counted as lacking servers. */
export function compareMcpServers(
  servers: ReadonlyArray<ProviderMcpServer>,
  peers: ReadonlyArray<McpPeerServers>,
): McpServersComparison {
  const answered = peers.flatMap((peer) =>
    peer.servers === null
      ? []
      : [
          {
            label: peer.label,
            byName: new Map(peer.servers.map((server) => [server.name, server])),
          },
        ],
  );
  const here = new Set(servers.map((server) => server.name));
  const byName = new Map<string, McpServerComparison>();
  for (const server of servers) {
    const missingOn: Array<string> = [];
    const differentOn: Array<McpServerDifference> = [];
    for (const peer of answered) {
      const there = peer.byName.get(server.name);
      if (there === undefined) missingOn.push(peer.label);
      else if (differs(server, there)) differentOn.push({ label: peer.label, server: there });
    }
    if (missingOn.length > 0 || differentOn.length > 0) {
      byName.set(server.name, { missingOn, differentOn });
    }
  }
  const elsewhere = new Map<string, Array<string>>();
  for (const peer of answered) {
    for (const name of peer.byName.keys()) {
      if (here.has(name)) continue;
      const labels = elsewhere.get(name);
      if (labels) labels.push(peer.label);
      else elsewhere.set(name, [peer.label]);
    }
  }
  return {
    byName,
    onlyElsewhere: [...elsewhere]
      .map(([name, labels]) => ({ name, labels }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}
