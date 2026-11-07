import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { t } from "../../lib/i18n";
import type { ComposerMediaSource } from "../../lib/composerImages";

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly supportsFiles: boolean;
  readonly onPickMedia: (source?: ComposerMediaSource) => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const { scale } = useAndroidControlSizing();
  const attachmentMenuActions: MenuAction[] = [
    { id: "photos", title: t("Photo Library"), image: "photo" },
    { id: "camera", title: t("Take Photo"), image: "camera" },
    ...(props.supportsFiles ? [{ id: "files", title: t("Choose Files"), image: "folder" }] : []),
  ];
  const button = (
    <Pressable
      accessibilityLabel={t("Add attachment")}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
    >
      <SymbolView
        name="plus"
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  if (props.disabled) {
    return button;
  }

  return (
    <Menu
      accessible
      accessibilityLabel={t("Add attachment")}
      accessibilityRole="button"
      actions={attachmentMenuActions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") {
          void props.onPickMedia("library");
        } else if (nativeEvent.event === "camera") {
          void props.onPickMedia("camera");
        } else if (nativeEvent.event === "files") {
          void props.onPickFiles();
        }
      }}
    >
      {button}
    </Menu>
  );
}
