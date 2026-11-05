import { useNavigation } from "@react-navigation/native";

/** Artifacts open over the current tab, as the archive does, so Back returns to the list that opened them. */
export function useOpenArtifacts() {
  const navigation = useNavigation();
  return () => navigation.navigate("Artifacts");
}
