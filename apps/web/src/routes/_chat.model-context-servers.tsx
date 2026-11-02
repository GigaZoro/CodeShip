import { createFileRoute } from "@tanstack/react-router";

import { McpServersPage } from "../components/mcp/McpServersPage";

export const Route = createFileRoute("/_chat/model-context-servers")({
  component: McpServersPage,
});
