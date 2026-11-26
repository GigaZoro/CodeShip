import { CLOUD_SPEECH_PROVIDER_NAMES, type CloudSpeechProvider } from "@t3tools/contracts";
import { msg, t } from "./i18n.ts";

/** @public */
export function cloudSpeechDisclosure(
  provider: CloudSpeechProvider,
  environment: string,
  resolve: typeof t = t,
) {
  return provider === "openrouter"
    ? resolve(
        msg(
          "After you stop, {environment} sends the recording to OpenRouter. OpenRouter chooses who runs your model. T3.CodeShip requests zero data retention; your OpenRouter account may allow safety retention.",
        ),
        { environment },
      )
    : resolve(
        msg(
          "After you stop, {environment} sends your recording and vocabulary hints, including project names, to {provider}.",
        ),
        { environment, provider: CLOUD_SPEECH_PROVIDER_NAMES[provider] },
      );
}
