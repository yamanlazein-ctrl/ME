import { Linking, Pressable, View } from "react-native";
import { Text } from "./Text";
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
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.warning,
        padding: spacing.md,
        borderRadius: radius.md,
        margin: spacing.sm,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <Text style={{ color: colors.warning, fontSize: fontSize.body }}>
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
        <Text style={{ color: colors.primaryForeground, fontSize: fontSize.body }}>تحديث</Text>
      </Pressable>
    </View>
  );
}
