import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { runConditionInput } from "@t3tools/client-runtime/scheduled-task-run-condition";
import {
  createDraft,
  duplicateDraft,
  editDraft,
  hasScheduledTaskDraftChanges,
  runConditionLostOnTarget,
  scheduledTaskDefaultModel,
  DEFAULT_SCHEDULE,
  scheduleDraftForTask,
  scheduleFromDraft,
} from "./scheduledTaskDraft";

describe("scheduleDraftForTask", () => {
  it("opens legacy sub-minute schedules at the writable minimum", () => {
    const draft = scheduleDraftForTask({ schedule: { type: "interval", everyMs: 30_000 } });
    expect(draft.intervalMinutes).toBe("1");
    expect(scheduleFromDraft(draft)).toEqual({ type: "interval", everyMs: 60_000 });
  });

  it("round-trips dedupe settings and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 3600,
    };
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, dedupe } });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a webhook signature on save without sending a secret", () => {
    const signature = {
      header: "x-hub-signature-256",
      encoding: "hex" as const,
      prefix: "sha256=",
    };
    const saved = scheduleFromDraft(
      scheduleDraftForTask({ schedule: { type: "webhook", signature } }),
    );
    expect(saved).toEqual({ type: "webhook", signature, maxDeliveryAgeMinutes: null, dedupe: {} });
    expect(saved?.type === "webhook" && saved.signature && "secret" in saved.signature).toBe(false);
  });

  it("round-trips webhook filters and refuses an invalid one", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.label.name", op: "in", value: ["needs review", "agent:fix"] },
    ] as const;
    const draft = scheduleDraftForTask({ schedule: { type: "webhook", signature: null, filters } });
    // Untouched rows are left out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft(draft)).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(1) })).toMatchObject({
      filters: filters.slice(1),
    });
    expect(
      scheduleFromDraft({ ...draft, filters: [{ id: "f1", path: "", op: "exists", value: "" }] }),
    ).toBeNull();
    // A duplicate has nothing stored yet, so it sends the filters it starts with.
    const copy = duplicateDraft(
      {
        title: "Triage",
        schedule: { type: "webhook", signature: null, filters },
        workspaceStrategy: { type: "root" },
      } as unknown as ScheduledTask,
      "Triage (copy)",
    );
    expect(copy.task).toBeNull();
    expect(scheduleFromDraft(copy.schedule)).toMatchObject({ filters });
  });
});

describe("scheduleFromDraft", () => {
  it("rejects an empty day selection rather than silently scheduling every day", () => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, weekdays: [] })).toBeNull();
  });

  it.each([
    ["1.5", 90_000],
    ["2,5", 150_000],
    [" 2,5 ", 150_000],
    [String(60_001 / 60_000), 60_001],
  ])("preserves a valid %s minute interval when saving", (intervalMinutes, everyMs) => {
    expect(scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes })).toEqual({
      type: "interval",
      everyMs,
    });
  });

  it.each(["0,5", "2,5,0", "Infinity", "150119987580", ""])(
    "rejects invalid interval minutes: %s",
    (intervalMinutes) => {
      expect(
        scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "interval", intervalMinutes }),
      ).toBeNull();
    },
  );
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = (value: ServerConfig, project: Parameters<typeof scheduledTaskDefaultModel>[1]) =>
    scheduledTaskDefaultModel(value, project, null);
  it("prefers the project's configured model", () => {
    expect(resolve(config, { id: projectId, defaultModelSelection: projectSelection })).toEqual(
      projectSelection,
    );
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: projectSelection },
            },
          },
        },
        { id: projectId },
      ),
    ).toEqual(projectSelection);
  });
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("keeps the explicit project default when its provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual({ instanceId: "unavailable", model: "missing" });
  });
  it("does not choose an implicit model on a disabled provider", () => {
    expect(
      resolve(
        {
          ...config,
          settings: {
            ...config.settings,
            defaultModelSelection: null,
            providerInstances: {
              [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
          },
          providers: config.providers.map((provider) => ({ ...provider, enabled: false })),
        },
        null,
      ),
    ).toBeNull();
  });
});

it("rejects dedupe keys without valid request placeholders", () => {
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", replayKey: "literal" }),
  ).toBeNull();
  expect(
    scheduleFromDraft({ ...DEFAULT_SCHEDULE, mode: "webhook", coalesceKey: "{{body.bad" }),
  ).toBeNull();
});

describe("run condition draft", () => {
  const task = {
    title: "Poll",
    prompt: "p",
    schedule: { type: "interval", everyMs: 60_000 },
    workspaceStrategy: { type: "root" },
    runCondition: { command: "node check.mjs", timeoutSeconds: 120 },
  } as unknown as ScheduledTask;

  it("round-trips a stored condition, carries it into a duplicate and notices edits", () => {
    const draft = editDraft(task);
    expect(runConditionInput(draft.runCondition)).toEqual({
      command: "node check.mjs",
      timeoutSeconds: 120,
    });
    expect(duplicateDraft(task, "Copy").runCondition).toEqual(draft.runCondition);
    const edited = { ...draft, runCondition: { ...draft.runCondition, command: "node other.mjs" } };
    expect(hasScheduledTaskDraftChanges(draft, edited)).toBe(true);
    expect(hasScheduledTaskDraftChanges(draft, { ...draft })).toBe(false);
  });

  it("clears with an empty command and ignores the timeout of a task without one", () => {
    const cleared = { ...editDraft(task).runCondition, command: "" };
    expect(runConditionInput(cleared)).toBeNull();
    const blank = createDraft(null, null);
    expect(
      hasScheduledTaskDraftChanges(blank, {
        ...blank,
        runCondition: { ...blank.runCondition, timeoutSeconds: "300" },
      }),
    ).toBe(false);
  });
});

describe("a check the target machine cannot keep", () => {
  const checked = {
    ...createDraft(null, null),
    runCondition: { command: "node check.mjs", timeoutSeconds: "120" },
  };

  it.each([
    ["target supports checks", true, checked, false],
    ["target lacks checks and the draft has a command", false, checked, true],
    ["target lacks checks and the command is empty", false, createDraft(null, null), false],
    [
      "target lacks checks and the command is blank",
      false,
      { ...checked, runCondition: { ...checked.runCondition, command: "  " } },
      false,
    ],
    [
      "target lacks checks and the trigger is a webhook",
      false,
      { ...checked, schedule: { ...checked.schedule, mode: "webhook" as const } },
      false,
    ],
  ])("%s", (_name, targetSupportsRunConditions, draft, lost) => {
    expect(runConditionLostOnTarget({ targetSupportsRunConditions, draft })).toBe(lost);
  });
});

describe("a task that reads its prompt from a file", () => {
  const lastRead = { at: "2026-11-12T08:00:00.000Z", ref: "origin/main", commit: "abcdef1234567" };
  const fileTask = {
    title: "Poll",
    prompt: "Do the daily thing",
    schedule: { type: "interval", everyMs: 60_000 },
    workspaceStrategy: { type: "root" },
    promptFile: { path: "automations/daily.md", lastRead },
  } as unknown as ScheduledTask;

  it("opens in file mode and a duplicate starts unread", () => {
    expect(editDraft(fileTask)).toMatchObject({
      promptSource: "file",
      promptFile: "automations/daily.md",
      savedPromptFile: "automations/daily.md",
      promptLastRead: lastRead,
    });
    expect(duplicateDraft(fileTask, "Copy")).toMatchObject({
      promptSource: "file",
      savedPromptFile: null,
      promptLastRead: null,
    });
  });

  it("notices a changed path", () => {
    const draft = editDraft(fileTask);
    expect(hasScheduledTaskDraftChanges(draft, { ...draft, promptFile: "automations/x.md" })).toBe(
      true,
    );
  });
});
