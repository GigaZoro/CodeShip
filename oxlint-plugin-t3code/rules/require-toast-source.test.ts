import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const FILE = "apps/web/src/components/Emitter.tsx";
const strict = createOxlintRuleHarness("t3code/require-toast-source", {
  filename: FILE,
  ruleOptions: [{ grandfathered: {} }],
});
const grandfathered = createOxlintRuleHarness("t3code/require-toast-source", {
  filename: FILE,
  ruleOptions: [{ grandfathered: { [FILE]: 1 } }],
});

describe("t3code/require-toast-source", () => {
  strict.valid(
    "allows a toast tagged with data.source, directly or through a const",
    `
      declare const toastManager: { add(options: object): string };
      declare const anchoredToastManager: { add(options: object): string };
      declare function stackedThreadToast<T>(options: T): T;
      toastManager.add({ type: "info", title: "a", data: { source: "slow-rpc" } });
      anchoredToastManager.add(stackedThreadToast({ title: "b", data: { source: "guide-run" } }));
      const options = { title: "c", data: { source: "host-freeze" } };
      toastManager.add(options);
    `,
  );

  strict.invalid(
    "reports a toast without a source",
    `
      declare const toastManager: { add(options: object): string };
      toastManager.add({ type: "error", title: "Could not save" });
    `,
    (output) => {
      assert.match(output, /Tag this toast with data\.source/);
      assert.match(output, /allows 0/);
    },
  );

  strict.invalid(
    "does not take a source outside data for a tag",
    `
      declare const toastManager: { add(options: object): string };
      declare function t(message: string, values: object): string;
      declare function track(event: object): void;
      toastManager.add({ type: "error", title: t("Failed to read {source}", { source: "x" }) });
      toastManager.add({ title: "a", actionProps: { onClick: () => track({ source: "x" }) } });
    `,
    (output) => {
      assert.match(output, /has 2 untagged toasts/);
    },
  );

  grandfathered.valid(
    "allows the untagged calls the baseline still counts for the file",
    `
      declare const toastManager: { add(options: object): string };
      toastManager.add({ type: "error", title: "Could not save" });
    `,
  );

  grandfathered.invalid(
    "reports every untagged call once the file has more than its baseline",
    `
      declare const toastManager: { add(options: object): string };
      toastManager.add({ type: "error", title: "Could not save" });
      toastManager.add({ type: "error", title: "Could not load" });
    `,
    (output) => {
      assert.match(output, /has 2 untagged toasts/);
      assert.match(output, /allows 1/);
    },
  );
});
