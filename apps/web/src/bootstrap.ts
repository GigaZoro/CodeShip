import { showBootError } from "./lib/bootError";
import { startLanguage } from "./languageBoot";

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
// The language goes first so modules and the first render already use it.
void startLanguage()
  .then(() => import("./main"))
  .then(({ startup }) => startup)
  .catch(showBootError);
