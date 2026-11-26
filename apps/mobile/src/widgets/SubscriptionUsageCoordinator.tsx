import { getActiveLanguage } from "@t3tools/shared/i18n";
import { t, getFormattingLocale } from "../lib/i18n";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import * as Linking from "expo-linking";
import { useEffect, useEffectEvent } from "react";
import { Platform } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { republishAgentActivityWidget } from "./publishAgentActivityWidget";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { createWidgetTheme } from "./widgetTheme";

// Isolate quota changes from the much busier thread/config presentation stream.
// One atom per UI language, so a language switch republishes the widget's copy.
const snapshotAtoms = new Map<string, ReturnType<typeof makeSnapshotAtom>>();

function makeSnapshotAtom(resolve: typeof t) {
  return Atom.make((get) =>
    buildSubscriptionUsageSnapshot(
      get(environmentPresentations.presentationsWithProvidersAtom),
      Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
      Platform.OS === "android" ? Infinity : 6,
      resolve,
    ),
  ).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));
}

function snapshotAtom(locale: string, resolve: typeof t) {
  let atom = snapshotAtoms.get(locale);
  if (atom === undefined) {
    atom = makeSnapshotAtom(resolve);
    snapshotAtoms.set(locale, atom);
  }
  return atom;
}

export function SubscriptionUsageCoordinator() {
  const {
    themeMode,
    themeAppearance,
    themeVariablesByAppearance,
    isReady: appearanceReady,
  } = useAppearancePreferences();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const resolve = t;
  const locale = getFormattingLocale() ?? getActiveLanguage();
  const snapshot = useAtomValue(snapshotAtom(locale, resolve));
  const androidAppearance = Platform.OS === "android" ? themeAppearance : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes subscription usage and theme to the native home screen widget
  useEffect(() => {
    if (!catalog.isReady || !appearanceReady) return;
    void Promise.resolve()
      .then(() =>
        publishSubscriptionUsage({
          ...snapshot,
          theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
        }),
      )
      .catch((error: unknown) => {
        console.warn("Could not update subscription usage widget", error);
      });
  }, [
    catalog.isReady,
    appearanceReady,
    snapshot,
    themeMode,
    themeVariablesByAppearance,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Android stores resolved colors; System appearance changes must republish them.
    androidAppearance,
  ]);
  const republishActivity = useEffectEvent(() => {
    republishAgentActivityWidget(resolve).catch((error: unknown) => {
      console.warn("Could not update agent activity widget", error);
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- republishes the agent activity widget's copy in the new UI language
  useEffect(
    () => republishActivity(),
    [
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the widget's copy follows the UI language.
      locale,
    ],
  );
  return null;
}
