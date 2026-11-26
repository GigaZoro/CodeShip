import { msg, t, type Message } from "./i18n.ts";

import type { CodexArtifactTemplateKind } from "./codexArtifactTemplates.ts";

const PRESENTATION_LABEL_BY_KIND = {
  document: msg("Document template"),
  presentation: msg("Presentation template"),
  spreadsheet: msg("Spreadsheet template"),
  site: msg("Site template"),
  "google-docs": msg("Google Doc template"),
  "google-slides": msg("Google Slides template"),
  "google-sheets": msg("Google Sheet template"),
  image: msg("Image template"),
  email: msg("Email template"),
  slack: msg("Slack template"),
} satisfies Record<CodexArtifactTemplateKind, Message>;

/** @public */
export function codexArtifactTemplatePresentationLabel(
  kind: CodexArtifactTemplateKind,
  resolve: typeof t = t,
): string {
  return resolve(PRESENTATION_LABEL_BY_KIND[kind]);
}
