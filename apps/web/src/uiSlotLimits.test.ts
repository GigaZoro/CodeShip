import { describe, expect, it } from "vite-plus/test";

import { COMPOSER_RESTING_CONTROLS } from "./components/chat/composerControlsOwnership";
import { THREAD_DETAILS_ITEMS } from "./components/chat/threadDetailsItems";
import { SIDEBAR_NAV_DESTINATIONS } from "./components/sidebar/mainAppLocation";

// A new feature claims an existing slot or removes something (docs/internals/web-ui.md, "Claim a
// slot or remove one"). Raising any limit here needs the user's agreement, quoted in the change
// description.
const THREAD_DETAILS_DEFAULT_VISIBLE_LIMIT = 7;
// Today's count until the rail is trimmed from the usage counters (AB#7516); then lower it.
const NAV_RAIL_ITEM_LIMIT = 12;
const COMPOSER_RESTING_CONTROL_LIMIT = 3;

describe("default-visible UI counts", () => {
  it("thread details show at most the limit by default", () => {
    expect(THREAD_DETAILS_ITEMS.filter((item) => item.defaultVisible).length).toBeLessThanOrEqual(
      THREAD_DETAILS_DEFAULT_VISIBLE_LIMIT,
    );
  });

  it("the nav rail holds at most the limit", () => {
    expect(SIDEBAR_NAV_DESTINATIONS.length).toBeLessThanOrEqual(NAV_RAIL_ITEM_LIMIT);
  });

  it("the composer footer shows at most the limit of controls at rest", () => {
    expect(COMPOSER_RESTING_CONTROLS.length).toBeLessThanOrEqual(COMPOSER_RESTING_CONTROL_LIMIT);
  });
});
