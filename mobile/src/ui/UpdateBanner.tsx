import { Linking, Pressable, Text, View } from "react-native";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export const UPDATE_REQUIRED_TEXT = "تحديث مطلوب";

export interface UpdateBannerProps {
  visible: boolean;
  /** Play Store listing or the APK download URL (E9). */
  url: string;
  onOpen?: (url: string) => void;
}

/** Shown on every screen while the hub refuses this app version; local work continues (E9). */
export function UpdateBanner({
  visible,
  url,
  onOpen = (u) => void Linking.openURL(u),
}: UpdateBannerProps) {
  if (!visible) return null;
  return (
    <View
      testID="update-banner"
      style={{
        backgroundColor: "#fef3c7",
        padding: spacing.md,
        borderRadius: radius.md,
        margin: spacing.sm,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Text style={{ color: "#92400e", fontSize: fontSize.body }}>
        {UPDATE_REQUIRED_TEXT} — المزامنة متوقفة
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="تحديث"
        onPress={() => onOpen(url)}
        style={{
          minHeight: TOUCH_TARGET,
          minWidth: TOUCH_TARGET,
          justifyContent: "center",
          paddingHorizontal: spacing.md,
          backgroundColor: colors.primary,
          borderRadius: radius.md,
        }}
      >
        <Text style={{ color: "#fff", fontSize: fontSize.body }}>تحديث</Text>
      </Pressable>
    </View>
  );
}
