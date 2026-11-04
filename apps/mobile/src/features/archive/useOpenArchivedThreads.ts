import { useNavigation } from "@react-navigation/native";

/**
 * Archived threads open over the current tab, so Back returns to the list that opened them.
 * It is a plain `Archive` route, not a Settings page, so no Settings column opens for it.
 */
export function useOpenArchivedThreads() {
  const navigation = useNavigation();
  return () => navigation.navigate("Archive");
}
