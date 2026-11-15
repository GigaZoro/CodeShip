// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  AGENT_NICE_INCREMENT,
  AGENT_OOM_SCORE_ADJ,
  agentScopeCommand,
  agentScopeLauncherScript,
} from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

const MAX_NICE = 19;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("agent priority", () => {
  it("runs the agent, and what it starts, below the server's CPU priority", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: ["-c", '/bin/sh -c "ps -o nice= -p \\$\\$"'],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    expect(Number(child.stdout.trim())).toBe(
      Math.min(MAX_NICE, NodeOS.getPriority() + AGENT_NICE_INCREMENT),
    );
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);

    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-launcher-"));
    try {
      const launcher = NodePath.join(directory, "launch's");
      NodeFS.writeFileSync(launcher, agentScopeLauncherScript(launch), { mode: 0o700 });
      const launched = NodeChildProcess.spawnSync(launcher, ["--flag", "it's"], {
        encoding: "utf8",
      });
      const [launchedPid, launchedScore, ...launchedArgs] = launched.stdout.trimEnd().split("\n");
      expect(Number(launchedPid)).toBe(launched.pid);
      expect(Number(launchedScore)).toBe(AGENT_OOM_SCORE_ADJ);
      expect(launchedArgs).toEqual(["a b", "$HOME", "--flag", "it's"]);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
