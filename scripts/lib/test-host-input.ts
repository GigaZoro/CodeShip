// @effect-diagnostics nodeBuiltinImport:off - Node preloads this module before Vitest worker imports.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";

/** A host command makes the group read a unique workspace input that disappears before publication.
 * Vite+ can then replay only groups that never needed it, without recording commands or credentials. */
export function observeHostProcesses(marker: string, coordinator = false) {
  // The ESM namespace is read-only. Update Node's CommonJS exports and sync their ESM bindings.
  const require = NodeModule.createRequire(import.meta.url);
  let observed = false;
  const hostInput = () => {
    if (observed) return;
    NodeFS.readFileSync(marker);
    observed = true;
  };
  const workers = coordinator
    ? NodePath.join(
        NodePath.dirname(
          NodeModule.createRequire(import.meta.resolve("vite-plus/package.json")).resolve(
            "vitest/package.json",
          ),
        ),
        "dist/workers",
      )
    : undefined;
  const observedWorker = (file: unknown, name: string, args: unknown) =>
    workers !== undefined &&
    file === NodePath.join(workers, name) &&
    Array.isArray(args) &&
    args.some((arg, index) => arg === "--import" && args[index + 1] === import.meta.url);

  // The async APIs converge on ChildProcess.spawn. Node's sync APIs each call their private binding.
  const prototype = NodeChildProcess.ChildProcess.prototype;
  Reflect.set(
    prototype,
    "spawn",
    new Proxy(Reflect.get(prototype, "spawn"), {
      apply(target, receiver, args) {
        const options = args[0];
        if (
          options.file !== process.execPath ||
          !observedWorker(options.args?.at(-1), "forks.js", options.args)
        )
          hostInput();
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  for (const name of ["spawnSync", "execSync", "execFileSync"] as const) {
    Object.defineProperty(require("node:child_process"), name, {
      value: new Proxy(NodeChildProcess[name], {
        apply(target, receiver, args) {
          hostInput();
          return Reflect.apply(target, receiver, args);
        },
      }),
    });
  }
  Object.defineProperty(require("node:worker_threads"), "Worker", {
    value: new Proxy(NodeWorkerThreads.Worker, {
      construct(target, args, newTarget) {
        if (!observedWorker(args[0], "threads.js", args[1]?.execArgv)) hostInput();
        return Reflect.construct(target, args, newTarget);
      },
    }),
  });
  if (!coordinator) {
    process.dlopen = new Proxy(process.dlopen, {
      apply(target, receiver, args) {
        const [addon, binary] = args;
        const loader = addon.parent?.filename;
        // ffi-rs 1.3.2 initializes a table of functions on import. Server tests import it through
        // the file finder even without opening a host library. Observe calls to that pinned binding.
        if (
          typeof loader === "string" &&
          loader.endsWith(NodePath.join("node_modules", "ffi-rs", "index.js")) &&
          NodePath.basename(String(binary)).startsWith("ffi-rs.") &&
          NodeModule.createRequire(loader)("./package.json").version === "1.3.2"
        ) {
          const result = Reflect.apply(target, receiver, args);
          for (const [name, value] of Object.entries(addon.exports)) {
            if (typeof value === "function")
              Object.defineProperty(addon.exports, name, {
                value: new Proxy(value, {
                  apply(fn, self, params) {
                    hostInput();
                    return Reflect.apply(fn, self, params);
                  },
                  construct(fn, params, derived) {
                    hostInput();
                    return Reflect.construct(fn, params, derived);
                  },
                }),
              });
          }
          return result;
        }
        hostInput();
        return Reflect.apply(target, receiver, args);
      },
    });
  }
  NodeModule.syncBuiltinESMExports();
}

const marker = process.env.T3_CHECK_CHANGED_HOST_INPUT;
if (marker && process.execArgv.includes(import.meta.url)) {
  observeHostProcesses(marker);
  delete process.env.T3_CHECK_CHANGED_HOST_INPUT;
}
