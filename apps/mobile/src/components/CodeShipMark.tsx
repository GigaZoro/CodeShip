import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function CodeShipMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="CodeShip"
      height={props.height}
      width={props.height}
      viewBox="0 0 32 32"
    >
      <ThemedPath
        d="M10 7 1 16l9 9 2-3-6-6 6-6Zm12 0-2 3 6 6-6 6 2 3 9-9ZM19 4h-3l-4 24h3Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
