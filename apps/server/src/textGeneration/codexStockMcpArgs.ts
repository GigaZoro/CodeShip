import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";

const isTable = (value: TomlValue | undefined): value is TomlTable =>
  value !== undefined &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const quoteKey = (name: string) => JSON.stringify(name).replaceAll("\x7f", "\\u007f");

function inlineToml(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(inlineToml).join(",")}]`;
  if (isTable(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${quoteKey(key)}=${inlineToml(entry)}`)
      .join(",")}}`;
  }
  return stringify({ v: value }, { numbersAsFloat: true }).slice("v = ".length).trimEnd();
}

function rootWithDisabledServers(names: ReadonlyArray<string>, rawRoot?: string): string {
  if (rawRoot === undefined)
    return `mcp_servers={${names.map((name) => `${quoteKey(name)}={enabled=false}`).join(",")}}`;
  let root: TomlTable = {};
  try {
    const value = parse(`v = ${rawRoot}`, { integersAsBigInt: true }).v;
    if (isTable(value)) root = value;
  } catch {
    // Codex treats unparseable override values as scalars, which a subsequent nested override replaces.
  }
  const disabled = Object.fromEntries(
    names.map((name) => {
      const server = Object.hasOwn(root, name) ? root[name] : undefined;
      return [name, { ...(isTable(server) ? server : {}), enabled: false }];
    }),
  );
  return `mcp_servers=${inlineToml({ ...root, ...disabled })}`;
}

export function codexExecArgsWithoutMcp(
  launchArgs: ReadonlyArray<string>,
  enabledNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (enabledNames.length === 0) return launchArgs;

  let hasMcpOverride = false;
  let lastRoot: { index: number; prefix: string; value: string } | undefined;
  for (const [index, arg] of launchArgs.entries()) {
    const prefix = arg.startsWith("--config=") ? "--config=" : arg.startsWith("-c=") ? "-c=" : "";
    if (!prefix && launchArgs[index - 1] !== "--config" && launchArgs[index - 1] !== "-c") continue;
    const assignment = arg.slice(prefix.length);
    const equals = assignment.indexOf("=");
    if (equals < 0) continue;
    const key = assignment.slice(0, equals).trim();
    if (key === "mcp_servers") {
      hasMcpOverride = true;
      lastRoot = { index, prefix, value: assignment.slice(equals + 1).trim() };
    } else if (key.startsWith("mcp_servers.")) {
      hasMcpOverride = true;
    }
  }

  if (!hasMcpOverride) return [...launchArgs, "--config", rootWithDisabledServers(enabledNames)];
  const args = [...launchArgs];
  // Codex splits CLI keys at every dot and the first '='. Only the whole table can address literal names.
  const literalNames = enabledNames.filter((name) => /[.=]/.test(name));
  if (literalNames.length > 0) {
    const root = rootWithDisabledServers(literalNames, lastRoot?.value);
    if (lastRoot) args[lastRoot.index] = lastRoot.prefix + root;
    else args.unshift("--config", root);
  }
  for (const name of enabledNames) {
    if (!/[.=]/.test(name)) args.push("--config", `mcp_servers.${name}.enabled=false`);
  }
  return args;
}
