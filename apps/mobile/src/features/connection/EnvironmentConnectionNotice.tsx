import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/ui/AppSymbol";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { t } from "../../lib/i18n";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return t("You are offline");
    case "connecting":
      return t("Connecting to {name}...", { name: environmentLabel });
    case "reconnecting":
      return t("Reconnecting to {name}...", { name: environmentLabel });
    case "unsupported":
      return t("Client not supported");
    case "error":
      return t("{name} is unavailable", { name: environmentLabel });
    case "available":
      return t("{name} is disconnected", { name: environmentLabel });
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
): string {
  if (error) {
    return phase === "reconnecting"
      ? t("The app will keep retrying automatically. {error}", { error })
      : error;
  }

  switch (phase) {
    case "offline":
      return t(
        "Cached data remains available. The {resource} will load when your connection returns.",
        {
          resource: resourceName,
        },
      );
    case "connecting":
    case "reconnecting":
      return t("The {resource} will load as soon as the environment is ready.", {
        resource: resourceName,
      });
    case "unsupported":
      return t("Use compatible versions of the app and server to connect.");
    case "available":
    case "error":
      return t("Reconnect the environment to load the {resource}.", { resource: resourceName });
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <AppActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resourceName, props.connection.error)}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <View className="mt-1">
            <Button label={t("Retry now")} tone="secondary" onPress={props.onRetry} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
