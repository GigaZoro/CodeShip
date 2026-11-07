import * as Schema from "effect/Schema";

import { writeLocalStorageValue } from "../../hooks/useLocalStorage";

export const SETTLED_SHELF_EXPANDED_KEY = "t3code:sidebar:settled-expanded";

export function expandSettledShelf() {
  writeLocalStorageValue(SETTLED_SHELF_EXPANDED_KEY, true, false, Schema.Boolean);
}
