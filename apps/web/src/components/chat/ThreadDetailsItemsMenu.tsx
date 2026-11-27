import { t } from "~/i18n";
import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
} from "../ui/menu";
import {
  matchingThreadDetailsPreset,
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
  THREAD_DETAILS_PRESETS,
  threadDetailsItemsForPreset,
} from "./threadDetailsItems";

/** Menu body that shows and hides thread details items. The card's context menu and Settings share it. */
export function ThreadDetailsItemsMenuItems() {
  const visibility = useClientSettings(resolveThreadDetailsVisibility);

  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>{t("Presets")}</MenuGroupLabel>
        <MenuRadioGroup
          value={matchingThreadDetailsPreset(visibility)?.id ?? null}
          onValueChange={(id) => {
            const preset = THREAD_DETAILS_PRESETS.find((candidate) => candidate.id === id);
            if (preset)
              updateClientSettings({ threadDetailsItems: threadDetailsItemsForPreset(preset) });
          }}
        >
          {THREAD_DETAILS_PRESETS.map((preset) => (
            <MenuRadioItem key={preset.id} value={preset.id}>
              <span className="flex items-center justify-between gap-3">
                {t(preset.label)}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>{t("Show in thread details")}</MenuGroupLabel>
        {THREAD_DETAILS_ITEMS.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) =>
              updateClientSettings({
                threadDetailsItems: setThreadDetailsItem(getClientSettings(), item, checked),
              })
            }
          >
            {t(item.label)}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
    </>
  );
}
