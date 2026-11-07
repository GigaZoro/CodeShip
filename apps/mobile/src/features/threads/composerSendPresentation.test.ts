import { describe, expect, it } from "vite-plus/test";

import { resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  canSteer: false,
  canRestart: false,
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("shows the outbox action when delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({ ...idle, deliveryDeferred: true });
    expect(presentation.label).toBe("Queue");
    expect(presentation.icon).toBe("tray.and.arrow.up");
    expect(resolveComposerSendPresentation(idle).icon).toBe("arrow.up");
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      canSteer: false,
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.choices).toEqual([]);
    expect(presentation.offersFollowUpChoice).toBe(false);
  });

  it("offers stop and send only when the running turn can restart", () => {
    const running = { ...idle, running: true, canSteer: true, followUpBehavior: "steer" } as const;

    expect(resolveComposerSendPresentation(running).choices).toEqual(["steer", "queue"]);
    const presentation = resolveComposerSendPresentation({
      ...running,
      canRestart: true,
      followUpBehavior: "restart",
    });
    expect(presentation.label).toBe("Stop and send");
    expect(presentation.alternate).toBe("queue");
    expect(presentation.choices).toEqual(["steer", "queue", "restart"]);
  });
});
