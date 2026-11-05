import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { HtmlRenderWebView } from "../threads/HtmlRenderWebView";
import { useArtifacts } from "./useArtifacts";
import { useDeleteArtifact } from "./useDeleteArtifact";
import { artifactKey, type EnvironmentArtifact } from "./artifactList";

type ArtifactViewerProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly attachmentId: string;
}>;

function ArtifactPage(props: { readonly artifact: EnvironmentArtifact }) {
  const { artifact } = props;
  const resource = {
    _tag: "attachment" as const,
    attachmentId: artifact.attachmentId,
    fileName: htmlRenderFileName(artifact.title),
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const asset = useAssetUrlState(artifact.environmentId, resource);
  const refresh = useRefreshAssetUrl(artifact.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setUri(next);
      else setAttempt((value) => value + 1);
    });
  };
  const retry = () => {
    retried.current = false;
    setFailed(false);
    if (uri === null) void refresh().then((next) => next !== null && setUri(next));
    else setAttempt((value) => value + 1);
  };

  if (uri !== null && !failed) {
    return (
      <HtmlRenderWebView
        key={`${uri}:${attempt}`}
        uri={uri}
        title={artifact.title}
        nested={false}
        onLoadError={handleLoadError}
      />
    );
  }
  if (failed || asset._tag === "Failure") {
    return (
      <View className="flex-1 items-center justify-center gap-3 px-8">
        <Text className="text-sm text-foreground-muted">This page could not be loaded.</Text>
        <Button label="Try again" tone="secondary" onPress={retry} />
      </View>
    );
  }
  return (
    <View className="flex-1 items-center justify-center">
      <AppActivityIndicator />
    </View>
  );
}

export function ArtifactViewerScreen({ route }: ArtifactViewerProps) {
  const navigation = useNavigation();
  const environmentIds = useAtomValue(connectedEnvironmentIdsAtom);
  const { artifacts, error, isLoading, refresh } = useArtifacts(environmentIds);
  const deleteArtifact = useDeleteArtifact();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const live = artifacts.find(
    (candidate) =>
      candidate.environmentId === environmentId &&
      candidate.attachmentId === route.params.attachmentId,
  );
  // A brief environment disconnect drops the list; keep the page mounted meanwhile. The route
  // pins one version, and the list rebuilds its rows every render, so keep the first match only.
  const [kept, setKept] = useState(live);
  if (live && kept === undefined) setKept(live);
  const offline = !environmentIds.includes(environmentId);
  const artifact = live ?? (offline ? kept : undefined);
  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={artifact?.title ?? "Artifact"}
        {...(artifact ? { subtitle: artifact.threadTitle } : undefined)}
        sidebar={false}
        onBack={goBack}
        menus={
          artifact
            ? [
                {
                  title: "Artifact options",
                  icon: "ellipsis.circle",
                  items: [
                    {
                      id: "open-thread",
                      title: "Open thread",
                      icon: "bubble.left",
                      onPress: () =>
                        navigation.dispatch(
                          StackActions.push("Thread", {
                            environmentId: artifact.environmentId,
                            threadId: artifact.threadId,
                          }),
                        ),
                    },
                    {
                      id: "delete",
                      title: "Delete",
                      icon: "trash",
                      onPress: () => deleteArtifact(artifact, goBack),
                    },
                  ],
                },
              ]
            : undefined
        }
      />
      {artifact ? (
        <>
          {offline ? (
            <Text className="px-4 py-2 text-center text-xs text-foreground-muted">
              Environment offline. Showing the last loaded page.
            </Text>
          ) : null}
          <ArtifactPage key={artifactKey(artifact)} artifact={artifact} />
        </>
      ) : offline ? (
        <View className="flex-1 justify-center">
          <EmptyState
            title="Environment offline"
            detail="Reconnect to this environment to open the artifact."
            actionLabel="Back to artifacts"
            onAction={goBack}
          />
        </View>
      ) : isLoading ? (
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator />
        </View>
      ) : (
        <View className="flex-1 justify-center">
          <EmptyState
            title={error === null ? "Artifact not found" : "Could not load the artifact"}
            detail={error === null ? "It may have been deleted from another device." : error}
            actionLabel={error === null ? "Back to artifacts" : "Try again"}
            onAction={error === null ? goBack : refresh}
          />
        </View>
      )}
    </View>
  );
}
