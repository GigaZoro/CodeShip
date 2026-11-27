// @effect-diagnostics nodeBuiltinImport:off - scans real source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SEARCH_ITEMS, settingScopeAxes, settingScopeAxesById } from "./settingsSearch";
import type { SettingsSearchItem, SettingsSearchItemId } from "./settingsSearch";

const webSourceRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

const webSource = NodeFS.readdirSync(webSourceRoot, { recursive: true })
  .map(String)
  .filter((file) => /\.tsx$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .map((file) => NodeFS.readFileSync(NodePath.join(webSourceRoot, file), "utf8"))
  .join("\n");

const wrappedIds = new Set(
  [...webSource.matchAll(/<(?:SettingScope|MachineModelUnit)\s+setting="([^"]+)"/g)].map(
    (match) => match[1]!,
  ),
);

/** Child rows that render inside their parent's scope unit and share its pill. */
const SHARED_UNITS: Readonly<Partial<Record<SettingsSearchItemId, SettingsSearchItemId>>> = {
  "ghq-clone-layout": "add-project-starts-in",
};

function sharedUnit(id: SettingsSearchItemId) {
  return id.startsWith("source-control-host-") ? "source-control" : SHARED_UNITS[id];
}

const scopedItems = SETTINGS_SEARCH_ITEMS.filter((item) => settingScopeAxes(item) !== null);

/** Props of each `<SettingsRow` or `<SettingsSection` opening tag, nested braces blanked out. */
function settingsElementProps(source: string) {
  return [...source.matchAll(/<Settings(?:Row|Section)\b/g)].map((match) => {
    let depth = 0;
    let props = "";
    for (const char of source.slice(match.index + match[0].length)) {
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (depth === 0 && char === ">") break;
      props += depth <= 1 ? char : " ";
    }
    return props;
  });
}

const serverScopedIds = settingsElementProps(webSource)
  .filter((props) => /\sserverScoped(?=[\s/]|$)/.test(props))
  .flatMap((props) => [...props.matchAll(/searchableSetting\("([^"]+)"\)/g)].map((m) => m[1]!));

describe("setting scope coverage", () => {
  it.each(scopedItems.map((item) => [item.id, item as SettingsSearchItem] as const))(
    "%s renders inside its own scope unit",
    (id, item) => {
      const units = [sharedUnit(id) ?? id, item.targetId].filter(
        (unit): unit is SettingsSearchItemId => unit !== undefined,
      );
      const wrapping = units.filter((unit) => wrappedIds.has(unit));
      expect(wrapping, `wrap the ${id} row in <SettingScope setting="${units[0]}">`).not.toEqual(
        [],
      );
      expect(
        wrapping.map(settingScopeAxesById),
        `the unit around ${id} must offer the same scope`,
      ).toContain(settingScopeAxes(item));
    },
  );

  it("declares a machine or project scope for every row that writes server settings", () => {
    expect(serverScopedIds.length).toBeGreaterThan(0);
    const unscoped = serverScopedIds.filter(
      (id) => settingScopeAxesById(id as SettingsSearchItemId) === null,
    );
    expect(unscoped).toEqual([]);
  });

  it("wraps only settings that declare a machine or project scope", () => {
    expect(wrappedIds.size).toBeGreaterThan(0);
    for (const id of wrappedIds) {
      expect(settingScopeAxesById(id as SettingsSearchItemId), id).not.toBeNull();
    }
  });
});
