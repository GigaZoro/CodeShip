import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { mergeSavedThreadFolders } from "../threadFolders.ts";
import type { AtomCommand } from "./runtime.ts";

type SavedFolders = ReadonlyArray<string>;

type FoldersCommand<Input, A extends { readonly folders: SavedFolders }, E> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: Input },
  A,
  E
>;

const EMPTY_FOLDERS: SavedFolders = [];

function sameFolders(left: SavedFolders, right: SavedFolders): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Each machine's saved folders as its settings hold them, with the changes still on their way
 * already applied, so a new or moved folder shows at once.
 */
export function createSavedThreadFolders(
  settingsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Pick<ServerSettings, "threadFolders"> | null>,
) {
  const sourceAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(settingsAtom(environmentId))?.threadFolders ?? EMPTY_FOLDERS),
  );
  const pendingAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<(folders: SavedFolders) => SavedFolders>>([]).pipe(Atom.keepAlive),
  );
  const foldersAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      get(pendingAtom(environmentId)).reduce(
        (folders, change) => change(folders),
        get(sourceAtom(environmentId)),
      ),
    ).pipe(Atom.withEquality(sameFolders)),
  );

  /**
   * Shows the change until the settings show the command's result. The settings can arrive
   * before or after the reply, so the lists seen meanwhile are kept to tell which.
   */
  function wrap<
    Input,
    A extends { readonly folders: SavedFolders },
    E,
    C extends FoldersCommand<Input, A, E>,
  >(
    command: C & FoldersCommand<Input, A, E>,
    apply: (folders: SavedFolders, input: Input) => SavedFolders,
  ): C {
    return {
      ...command,
      run: async (registry, target) => {
        const pending = pendingAtom(target.environmentId);
        const source = sourceAtom(target.environmentId);
        const change = (folders: SavedFolders) => apply(folders, target.input);
        const seen: SavedFolders[] = [registry.get(source)];
        let replied = false;
        const finish = () => {
          unsubscribe();
          registry.update(pending, (current) => current.filter((item) => item !== change));
        };
        const unsubscribe = registry.subscribe(source, (folders) => {
          if (replied) finish();
          else seen.push(folders);
        });
        registry.update(pending, (current) => [...current, change]);
        try {
          const result = await command.run(registry, target);
          if (result._tag !== "Success") {
            finish();
            return result;
          }
          replied = true;
          if (seen.some((folders) => sameFolders(folders, result.value.folders))) finish();
          return result;
        } catch (cause) {
          finish();
          throw cause;
        }
      },
    };
  }

  return { foldersAtom, wrap };
}

/** The folders saved on every machine in `environmentIdsAtom`, as one list. */
export function createAllSavedThreadFoldersAtom(input: {
  readonly environmentIdsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, unknown>>;
  readonly foldersAtom: (environmentId: EnvironmentId) => Atom.Atom<SavedFolders>;
}) {
  return Atom.make((get) =>
    mergeSavedThreadFolders(
      [...get(input.environmentIdsAtom).keys()].map((environmentId) =>
        get(input.foldersAtom(environmentId)),
      ),
    ),
  ).pipe(Atom.withEquality(sameFolders), Atom.withLabel("thread-folders:saved"));
}
