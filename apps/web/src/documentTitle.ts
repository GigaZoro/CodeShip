import { formatAppWindowTitle } from "@t3tools/shared/windowTitle";

let appName: string | null = null;
let context: ReadonlyArray<string | null | undefined> = [];

function apply(): void {
  if (appName !== null) document.title = formatAppWindowTitle(context, appName);
}

export function setDocumentAppName(name: string): void {
  appName = name;
  apply();
}

/** Puts what the window shows ahead of the app name in the title until the returned cleanup runs. */
export function showInDocumentTitle(parts: ReadonlyArray<string | null | undefined>): () => void {
  context = parts;
  apply();
  return () => {
    if (context !== parts) return;
    context = [];
    apply();
  };
}
