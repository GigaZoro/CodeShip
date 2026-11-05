import { View } from "react-native";
import { Notice } from "../../components/ui/Notice";
import { t } from "../../lib/i18n";

export function ComposerErrorNotice(props: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <View className="px-4 pb-3">
      <Notice
        message={props.message}
        icon="exclamationmark.circle"
        iconTone="danger"
        floating
        onDismiss={props.onDismiss}
        dismissLabel={t("Dismiss error")}
      />
    </View>
  );
}
