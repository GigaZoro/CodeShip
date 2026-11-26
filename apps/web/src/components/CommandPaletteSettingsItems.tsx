import { t } from "~/i18n";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { SettingsIcon } from "lucide-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { settingsForThisPlatform, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";

const NO_SETTINGS_ITEMS: ReadonlyArray<CommandPaletteActionItem> = [];

/**
 * Every setting as a palette row, so settings get the palette's word starts and typo
 * tolerance. Its own hook so the compiler keeps the rows across keystrokes. Only a search
 * lists settings, so opening the palette does not translate them.
 */
export function useCommandPaletteSettingsItems(
  searching: boolean,
): ReadonlyArray<CommandPaletteActionItem> {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  if (!searching) return NO_SETTINGS_ITEMS;
  return settingsForThisPlatform(availableSettingsSearchItems).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    // Matches the English and the displayed language, like the settings search.
    searchTerms: [
      item.title,
      t(item.title, item.titleValues),
      SETTINGS_SECTION_LABELS[item.to],
      t(SETTINGS_SECTION_LABELS[item.to]),
      ...(item.searchTerms ?? []),
    ],
    title: t(item.title, item.titleValues),
    description: t("Settings · {section}", { section: t(SETTINGS_SECTION_LABELS[item.to]) }),
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
}
