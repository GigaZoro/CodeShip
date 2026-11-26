import type { EnvironmentSpeechStatus } from "@t3tools/contracts";
import { effectiveSpeechLanguage } from "@t3tools/shared/speech";
import { getFormattingLocale, t } from "~/i18n";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const languageLabel = (code: string) =>
  new Intl.DisplayNames(getFormattingLocale() ?? "en", { type: "language" }).of(code) ?? code;

type ModelLanguages = Pick<
  Extract<EnvironmentSpeechStatus, { supported: true }>,
  "languages" | "supportsLanguageDetection"
>;

export function SpeechLanguageSelect({
  model,
  automaticLabel,
}: {
  readonly model: ModelLanguages | null;
  readonly automaticLabel?: string | undefined;
}) {
  const preference = useClientSettings((settings) => settings.speechLanguage);
  const languages = model?.languages ?? [];
  const resolved = model
    ? effectiveSpeechLanguage(
        { languages, supportsLanguageDetection: model.supportsLanguageDetection ?? false },
        preference,
      )
    : preference;
  const effectiveLabel =
    resolved === "auto" ? (automaticLabel ?? t("Auto-detect")) : languageLabel(resolved);
  const unavailable =
    preference !== "auto" && preference !== resolved
      ? t("{language} unavailable", { language: languageLabel(preference) })
      : null;
  const label = unavailable
    ? t("{language} ({status})", { language: effectiveLabel, status: unavailable })
    : preference === "auto" && resolved !== "auto"
      ? t("Auto ({language})", { language: effectiveLabel })
      : effectiveLabel;
  return (
    <Select
      value={preference}
      disabled={!model}
      onValueChange={(value) => {
        if (value) void updateClientSettings({ speechLanguage: value });
      }}
    >
      <SelectTrigger size="sm" aria-label={t("Transcription language")} className="max-w-64">
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value="auto">{t("Auto")}</SelectItem>
        {unavailable ? (
          <SelectItem value={preference} disabled>
            {unavailable}
          </SelectItem>
        ) : null}
        {languages
          .toSorted((left, right) => languageLabel(left).localeCompare(languageLabel(right)))
          .map((code) => (
            <SelectItem key={code} value={code}>
              {languageLabel(code)}
            </SelectItem>
          ))}
      </SelectPopup>
    </Select>
  );
}
