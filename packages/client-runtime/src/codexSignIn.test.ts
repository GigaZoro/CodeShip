import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { codexPrivateLoginApplies } from "./codexSignIn.ts";

describe("codexPrivateLoginApplies", () => {
  it.each([
    ["the built-in account on the shared login", "codex", {}, true],
    ["the built-in account with a blank home", "codex", { homePath: "  " }, true],
    ["the built-in account with its own home", "codex", { homePath: "/codex-home" }, false],
    ["the built-in account with its own auth folder", "codex", { shadowHomePath: "/a" }, false],
    ["an added account, which signs in apart already", "codex_work", {}, false],
  ])("%s", (_name, instanceId, config, applies) => {
    expect(codexPrivateLoginApplies(ProviderInstanceId.make(instanceId), config)).toBe(applies);
  });
});
