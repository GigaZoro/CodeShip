// @effect-diagnostics nodeBuiltinImport:off -- SDK spawn callbacks use Node handles directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

import { attachWindowsJob, windowsJobName } from "./windowsJob.ts";

/** The returned handle owns the host; closing its control pipe also ends the job on server exit. */
export const windowsJobSpawn = (host: string): typeof NodeChildProcess.spawn => {
  const spawn = (
    command: string,
    argsOrOptions?: ReadonlyArray<string> | NodeChildProcess.SpawnOptions,
    suppliedOptions?: NodeChildProcess.SpawnOptions,
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions) as
      | NodeChildProcess.SpawnOptions
      | undefined;
    const stdio = options?.stdio;
    const streams = Array.isArray(stdio)
      ? [...stdio]
      : Array.from({ length: 3 }, () => stdio ?? "pipe");
    while (streams.length < 3) streams.push("pipe");
    if (streams.includes("ipc"))
      throw new Error("Windows job SDK launches do not support Node IPC.");
    const fd = streams.length;
    const job = { host, name: windowsJobName(NodeCrypto.randomUUID()) };
    let executable = command;
    let argv = args;
    let raw = options?.windowsVerbatimArguments === true;
    if (options?.shell) {
      executable =
        typeof options.shell === "string" ? options.shell : (process.env.ComSpec ?? "cmd.exe");
      const content = [command, ...args].join(" ");
      raw = /cmd(?:\.exe)?$/i.test(executable);
      argv = raw ? ["/d", "/s", "/c", `"${content}"`] : ["-c", content];
    }
    const child = NodeChildProcess.spawn(
      host,
      [raw ? "owned-raw" : "owned", job.name, String(fd), executable, ...argv],
      {
        ...options,
        shell: false,
        windowsVerbatimArguments: false,
        windowsHide: true,
        stdio: [...streams, "pipe", "pipe"],
      },
    );
    attachWindowsJob(child, job);
    const control = child.stdio[fd] as NodeStream.Writable;
    const replies = child.stdio[fd + 1] as NodeStream.Readable;
    const lines = NodeReadline.createInterface({ input: replies });
    const fail = (error: Error) => {
      child.kill();
      child.emit("error", error);
    };
    control.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && child.exitCode === null) fail(error);
    });
    replies.on("error", fail);
    lines.on("line", (line) => {
      if (line === "W") control.write("R");
      else if (line.startsWith("E ")) {
        const [, code, detail] = line.split(" ");
        fail(
          Object.assign(new Error(Buffer.from(detail ?? "", "base64").toString()), {
            code: code === "2" || code === "3" ? "ENOENT" : code === "5" ? "EACCES" : "UNKNOWN",
            syscall: `spawn ${command}`,
            path: command,
            spawnargs: args,
          }),
        );
      }
    });
    child.once("close", () => lines.close());
    return child;
  };
  // All Node spawn overloads retain their stdio shape, with ownership descriptors appended.
  return spawn as typeof NodeChildProcess.spawn;
};
