import type { EnvironmentSpeechModel, SpeechBenchmarkTier } from "@t3tools/contracts";

import { t, tx } from "~/i18n";
import { languageLabel } from "./SpeechLanguageSelect";

const commonLanguages = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "bn",
  "pt",
  "id",
  "ur",
  "ru",
  "de",
  "ja",
  "mr",
  "vi",
  "te",
  "sw",
  "ha",
  "tr",
  "tl",
  "ta",
  "jw",
  "ko",
  "am",
  "th",
  "it",
  "gu",
  "kn",
  "yo",
];

export function orderSpeechLanguages(languages: readonly string[], preferred: readonly string[]) {
  const order = [...new Set([...preferred, ...commonLanguages])];
  const rank = new Map(order.map((code, index) => [code, index]));
  return languages.toSorted(
    (left, right) =>
      (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length) ||
      languageLabel(left).localeCompare(languageLabel(right)),
  );
}

export function ModelBenchmarks({
  model,
  languages,
  tier,
  facts,
}: {
  model: EnvironmentSpeechModel;
  languages: readonly string[];
  tier: SpeechBenchmarkTier | undefined;
  /** Plain facts, such as language count and size, shown after the scores. */
  facts: readonly string[];
}) {
  const data = model.benchmark;
  const seconds = tier === undefined ? undefined : data?.secondsPer30s[tier];
  const visible = !data
    ? []
    : languages.length
      ? languages
      : [model.languages.find((code) => data.accuracy[code]) ?? model.languages[0]].filter(
          (code): code is string => code !== undefined,
        );
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
      {visible.map((code) => {
        const score = data?.accuracy[code];
        return (
          <span key={code}>
            {score
              ? tx("{language}: {grade} ({errorPercent}% error)", {
                  language: languageLabel(code),
                  grade: <strong className="font-medium text-foreground">{score.grade}</strong>,
                  errorPercent: score.errorPercent,
                })
              : t("{language}: not benchmarked", { language: languageLabel(code) })}
          </span>
        );
      })}
      {data ? (
        <span>
          {seconds === undefined
            ? t("Speed: update server for this benchmark")
            : seconds == null
              ? t("Speed: not benchmarked")
              : tx("Speed: {seconds} / 30 s", {
                  seconds: (
                    <strong className="font-medium text-foreground">
                      {t("{seconds} s", { seconds: Number(seconds.toFixed(2)) })}
                    </strong>
                  ),
                })}
        </span>
      ) : null}
      {facts.map((fact) => (
        <span key={fact}>{fact}</span>
      ))}
    </div>
  );
}
