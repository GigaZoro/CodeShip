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
        d="M14 3v6l-6 6l6 3v4l-12 -6zM18 3l12 13l-12 6v-4l6 -3l-6 -6zM3 25h26l-4 4h-18z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
