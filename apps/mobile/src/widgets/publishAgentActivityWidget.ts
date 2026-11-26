import { t } from "../lib/i18n";

import type { AgentActivityWidgetSource } from "./agentActivityWidgetTimeline";

export async function publishAgentActivityWidget(
  _source: AgentActivityWidgetSource,
  _resolve?: typeof t,
) {}

export async function republishAgentActivityWidget(_resolve: typeof t) {}
