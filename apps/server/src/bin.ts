/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * They and Codex's managed-token helper dispatch before the full CLI module graph (seconds
 * of evaluation) loads; everything else defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";
import { enableCliCompileCache } from "./cliCompileCache.ts";

async function main() {
  const command = process.argv[2];
  if (command === "__command-log") {
    const { runPosixLogWriter } = await import("./commandRunner/posixLogWriter.ts");
    await runPosixLogWriter(process.argv.slice(3));
    return;
  }
  if (command === "__session-host") {
    const { runSessionHostBroker } = await import("./sessionHost/broker.ts");
    await runSessionHostBroker(process.argv.slice(3));
    return;
  }
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (
    process.env.T3CODE_VERIFY_INSTALL === "1" &&
    (command === "--version" || command === "__service-preflight")
  ) {
    const { dirname } = await import("node:path");
    const { embeddedCodexMetadataDigest, verifyCodexMetadataInstallation } =
      await import("@t3tools/shared/codexMetadataInventory");
    try {
      await verifyCodexMetadataInstallation(dirname(process.execPath), embeddedCodexMetadataDigest);
    } catch (error) {
      process.stderr.write(
        `Reinstall this t3 release to restore its Codex metadata package: ${String(error)}\n`,
      );
      process.exitCode = 78;
      return;
    }
  }
  if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    enableCliCompileCache();
    // Windows desktop launches without stdin; attach before reading, except on fast paths using pipes.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const importStart = performance.now();
    const { runCli } = await import("./binCli.ts");
    if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
      performance.measure("server.import.binCli", { start: importStart });
    }
    runCli();
  }
}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
)
  await main();
