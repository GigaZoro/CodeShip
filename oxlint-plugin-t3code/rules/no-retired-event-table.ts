import { defineRule } from "@oxlint/plugins";

const message =
  "orchestration_v2_events is retired and always empty: domain events live in orchestration_events (application_event_version = 2, stream_id = the thread id). Read from there, and seed tests through OrchestrationEventStore.appendAgentEvents.";

const RETIRED_TABLE = /\borchestration_v2_events\b/;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow naming the retired orchestration_v2_events table outside the migrations that copied it, since queries on it silently find nothing.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && RETIRED_TABLE.test(node.value)) {
          context.report({ node, message });
        }
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => RETIRED_TABLE.test(quasi.value.raw))) {
          context.report({ node, message });
        }
      },
    };
  },
});
