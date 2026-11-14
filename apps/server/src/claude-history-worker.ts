import { runClaudeHistoryWorker } from "./claudeHistoryWorker.ts";

const [method, input, rawOptions] = process.argv.slice(2);
await runClaudeHistoryWorker(method, input, rawOptions);
