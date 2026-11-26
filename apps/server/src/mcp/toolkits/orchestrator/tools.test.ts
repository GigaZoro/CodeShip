import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { ORCHESTRATOR_MCP_COMMAND_SHELLS } from "@t3tools/contracts";

import { COMMAND_SHELL_LABELS } from "../../../commandRunner/CommandRunner.ts";
import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "20000" };
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
