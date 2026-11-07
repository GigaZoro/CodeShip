import {
  OrchestratorMcpFailure,
  ProviderMcpNewServerName,
  type ProviderMcpError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProviderMcp from "../../../provider/ProviderMcp.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ProviderMcpToolkit } from "./tools.ts";

const isNewServerName = Schema.is(ProviderMcpNewServerName);

const providerFailure = (error: ProviderMcpError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "providerFailed" ? "orchestration_error" : "provider_unavailable",
    message: error.message,
  });

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(ProviderMcpToolkit, {
  t3_provider_mcp_servers: McpToolAccess.either(
    (input) => input.action === "list",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        yield* readCaller();
        const service = yield* ProviderMcp.ProviderMcp;
        const { servers } = yield* service
          .list({ instanceId: input.instanceId })
          .pipe(Effect.mapError(providerFailure));
        return { servers };
      }),
    ),
    McpToolAccess.writesEnvironment(({ instanceId, action, name, server }) =>
      Effect.gen(function* () {
        const service = yield* ProviderMcp.ProviderMcp;
        if (name === undefined) return yield* invalid(`\`${action}\` needs \`name\`.`);
        const target = { instanceId, name };
        switch (action) {
          case "add": {
            if (!isNewServerName(name)) {
              return yield* invalid(
                "Use only letters, numbers, hyphens, and underscores in `name`.",
              );
            }
            const config =
              server?.transport === "stdio"
                ? server
                : server?.url === undefined
                  ? undefined
                  : { ...server, url: server.url };
            if (config === undefined) {
              return yield* invalid("`add` needs `server` with its `url` or `command`.");
            }
            yield* service.add({ ...target, server: config });
            return { message: `Added ${name}. New sessions load it.` };
          }
          case "edit":
            if (server === undefined) return yield* invalid("`edit` needs `server`.");
            yield* service.edit({ ...target, server });
            return { message: `Changed ${name}. New sessions load the change.` };
          case "enable":
          case "disable":
            yield* service.setEnabled({ ...target, enabled: action === "enable" });
            return {
              message:
                action === "enable"
                  ? `Turned on ${name}. New sessions load it.`
                  : `Turned off ${name}; its settings are kept. New sessions leave it out.`,
            };
          case "remove":
            yield* service.remove(target);
            return { message: `Removed ${name}. New sessions leave it out.` };
          case "list":
            return yield* invalid("`list` changes nothing.");
        }
      }).pipe(
        Effect.catchTags({ ProviderMcpError: (error) => Effect.fail(providerFailure(error)) }),
      ),
    ),
  ),
});
