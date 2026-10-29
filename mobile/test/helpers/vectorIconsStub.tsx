// Icons render as their name in unit tests (the font is a native asset).
import { Text } from "react-native";

function Icon({ name }: { name: string }) {
  return <Text testID={`icon-${name}`}>{""}</Text>;
}
export const Ionicons = Object.assign(Icon, { glyphMap: {} as Record<string, number> });
