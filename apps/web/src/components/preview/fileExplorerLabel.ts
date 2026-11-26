import { msg, t } from "~/i18n";
import type { ExecutionEnvironmentPlatformOs, FileManagerRevealKind } from "@t3tools/contracts";

export function revealInFileExplorerLabel(platform: string, resolve: typeof t = t): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return resolve(msg("Reveal in Finder"));
  if (normalized.includes("win")) return resolve(msg("Reveal in File Explorer"));
  return resolve(msg("Reveal in Files"));
}

export function revealInFileExplorerLabelForOs(
  os: ExecutionEnvironmentPlatformOs,
  resolve: typeof t = t,
): string {
  if (os === "darwin") return resolve(msg("Reveal in Finder"));
  if (os === "windows") return resolve(msg("Reveal in File Explorer"));
  return resolve(msg("Reveal in Files"));
}

export function revealInFileExplorerLabelForKind(
  kind: FileManagerRevealKind,
  resolve: typeof t = t,
): string {
  if (kind === "finder") return resolve(msg("Reveal in Finder"));
  if (kind === "file-explorer") return resolve(msg("Reveal in File Explorer"));
  return resolve(msg("Reveal in Files"));
}
