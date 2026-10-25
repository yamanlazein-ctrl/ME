import { Text, View } from "react-native";
import { fontSize, spacing } from "./theme";

export const COMING_SOON_TEXT = "قريباً";

export function ComingSoon({ title }: { title: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl }}>
      <Text style={{ fontSize: fontSize.title }}>{title}</Text>
      <Text testID="coming-soon" style={{ fontSize: fontSize.body, marginTop: spacing.sm }}>
        {COMING_SOON_TEXT}
      </Text>
    </View>
  );
}
