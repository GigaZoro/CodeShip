import { describe, expect, it } from "@effect/vitest";

import { planWindowsRunRepair, type WindowsRunEntry } from "./DesktopLoginItem.ts";

const NAME = "com.t3tools.t3code";
const INSTALL = "C:\\Users\\user\\AppData\\Local\\Programs\\t3code";
const CURRENT = `${INSTALL}\\T3.CodeShip (Beta).exe`;
const OTHER_APP: WindowsRunEntry = {
  name: "OneDrive",
  command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background',
  disabled: false,
};

describe("planWindowsRunRepair", () => {
  it.each<{
    readonly name: string;
    readonly entries: ReadonlyArray<WindowsRunEntry>;
    readonly remove: ReadonlyArray<string>;
    readonly write: { readonly enabled: boolean } | null;
  }>([
    { name: "leaves other apps alone", entries: [OTHER_APP], remove: [], write: null },
    {
      name: "keeps an entry already on this executable",
      entries: [OTHER_APP, { name: NAME, command: `"${CURRENT}"`, disabled: false }],
      remove: [],
      write: null,
    },
    {
      name: "moves a hand-made entry for the executable a rename deleted",
      entries: [
        OTHER_APP,
        { name: "CodeShip", command: `"${INSTALL}\\CodeShip (Beta).exe"`, disabled: false },
      ],
      remove: ["CodeShip"],
      write: { enabled: true },
    },
    {
      name: "moves its own entry to the renamed executable",
      entries: [{ name: NAME, command: `"${INSTALL}\\CodeShip (Beta).exe"`, disabled: false }],
      remove: [],
      write: { enabled: true },
    },
    {
      name: "keeps an entry turned off in Task Manager off",
      entries: [{ name: NAME, command: `"${INSTALL}\\CodeShip (Beta).exe"`, disabled: true }],
      remove: [],
      write: { enabled: false },
    },
    {
      name: "reads an unquoted command with arguments, in any case and slash",
      entries: [
        {
          name: "T3 Code",
          command: `${INSTALL.toLowerCase().replaceAll("\\", "/")}/T3 Code (Alpha).EXE --hidden`,
          disabled: false,
        },
      ],
      remove: ["T3 Code"],
      write: { enabled: true },
    },
    {
      name: "drops a second entry that would start it twice",
      entries: [
        { name: NAME, command: `"${CURRENT}"`, disabled: false },
        { name: "CodeShip at sign-in", command: `"${CURRENT}"`, disabled: false },
      ],
      remove: ["CodeShip at sign-in"],
      write: { enabled: true },
    },
  ])("$name", ({ entries, remove, write }) => {
    expect(planWindowsRunRepair({ entries, executablePath: CURRENT, name: NAME })).toEqual({
      remove,
      write,
    });
  });
});
