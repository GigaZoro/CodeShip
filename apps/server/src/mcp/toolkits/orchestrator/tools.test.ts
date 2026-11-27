import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { ORCHESTRATOR_MCP_COMMAND_SHELLS } from "@t3tools/contracts";

import { COMMAND_SHELL_LABELS } from "../../../commandRunner/CommandRunner.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

// Agents on Windows write POSIX syntax because their Bash tool is Git Bash; `&&` then fails in
// PowerShell 5.1, and a `"` inside `bash -c '...'` never reaches bash.
it("names the shell t3_command_run uses on each platform and how to run POSIX syntax on Windows", () => {
  const description = OrchestratorToolkit.tools.t3_command_run.description ?? "";
  expect(description).toContain("bash or zsh on macOS and Linux");
  expect(description).toContain("Windows PowerShell 5.1");
  expect(description).toContain("no `&&` or `||`");
  expect(description).toContain('`shell: "bash"`');
  expect(description).toContain("$LASTEXITCODE");
  expect(description).toContain("a `bash` or `sh` runs Git Bash");
  expect(description).toContain("through `wsl`");
});

// The runner reports one of these in every result; the description has to name each.
it("names every shell t3_command_run can report in its description", () => {
  const description = OrchestratorToolkit.tools.t3_command_run.description ?? "";
  for (const shell of ORCHESTRATOR_MCP_COMMAND_SHELLS) {
    expect(description, shell).toContain(COMMAND_SHELL_LABELS[shell]);
  }
});

// A retried call is a new tool call: only the caller's key tells it from a second run.
it("requires the clientRequestId a retried t3_command_run reuses to find its command", () => {
  const tool = OrchestratorToolkit.tools.t3_command_run;
  const decode = Schema.decodeUnknownExit(tool.parametersSchema);
  expect(Exit.isFailure(decode({ command: "echo once" }))).toBe(true);
  expect(Exit.isSuccess(decode({ command: "echo once", clientRequestId: "run-1" }))).toBe(true);
  const schema = advertisedJsonSchema(tool) as {
    readonly required?: ReadonlyArray<string>;
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  expect(schema.required).toContain("clientRequestId");
  expect(schema.properties.clientRequestId?.description).toContain("instead of running it again");
  // Every tool that takes the key tells the agent how a retry uses it.
  for (const [name, other] of Object.entries(OrchestratorToolkit.tools)) {
    const advertised = advertisedJsonSchema(other) as typeof schema;
    if (advertised.properties?.clientRequestId === undefined) continue;
    expect(advertised.properties.clientRequestId.description, name).toMatch(/retry/i);
  }
});

// A new thread runs in this checkout, so create_threads ignored the environment and project a
// delegated task's target names, while their descriptions told the agent where the thread would run.
it("offers create_threads only the provider and model of a delegated task's target", () => {
  type Target = { readonly properties: Readonly<Record<string, unknown>> };
  const threads = advertisedJsonSchema(OrchestratorToolkit.tools.create_threads) as {
    readonly properties: {
      readonly threads: { readonly items: { readonly properties: { readonly target: Target } } };
    };
  };
  const task = advertisedJsonSchema(OrchestratorToolkit.tools.delegate_task) as {
    readonly properties: { readonly target: Target };
  };
  const model = ["providerInstanceId", "driverKind", "model", "options"];
  expect(Object.keys(threads.properties.threads.items.properties.target.properties)).toEqual(model);
  expect(Object.keys(task.properties.target.properties)).toEqual([
    ...model,
    "environmentId",
    "projectId",
  ]);
});

it("advertises the webhook guidance on the schedule tag and both signature alternatives", () => {
  const schema = advertisedJsonSchema(OrchestratorToolkit.tools.schedule_task);
  const properties = "properties.schedule.properties";
  expect(schema).toHaveProperty(
    properties + ".type.description",
    expect.stringContaining("'webhook': Run per webhook request."),
  );
  for (const index of [0, 1]) {
    const fields = properties + ".signature.anyOf." + index + ".properties";
    expect(schema).toHaveProperty(fields + ".secret.description", "Default: stored secret.");
    expect(schema).toHaveProperty(
      fields + ".secretRef.description",
      "From `request_secret`. Instead of `secret`. Spent by this save.",
    );
  }
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isSuccess(decode({ action: "set_color", color: null }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "set_color", color: "#fff" }))).toBe(true);
  expect(
    Exit.isSuccess(decode({ action: "set_notification_level", notificationLevel: "muted" })),
  ).toBe(true);
  expect(Exit.isFailure(decode({ action: "set_notification_level", color: "blue" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});
