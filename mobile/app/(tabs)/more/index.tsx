import { Alert, Pressable, ScrollView } from "react-native";
import { Text } from "../../../src/ui/Text";
import { router } from "expo-router";
import * as Font from "expo-font";
import { FONT_BY_WEIGHT } from "../../../src/ui/fontFamilies";
import { useTheme } from "../../../src/ui/ThemeContext";
import { getSessionService } from "../../../src/core/sessionService";
import { pendingLogoutMessage } from "../../../src/core/session";
import { notifyBootChanged } from "../../../src/hooks/useBoot";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "../../../src/ui/theme";

function Row({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        minHeight: TOUCH_TARGET,
        justifyContent: "center",
        padding: spacing.lg,
        backgroundColor: colors.card,
        borderRadius: radius.md,
        marginBottom: spacing.sm,
      }}
    >
      <Text style={{ fontSize: fontSize.body }}>{label}</Text>
    </Pressable>
  );
}

function fontsStatus(): string {
  const names = ["ionicons", ...Object.values(FONT_BY_WEIGHT)];
  const missing = names.filter((n) => !Font.isLoaded(n));
  return missing.length === 0 ? "الخطوط والأيقونات: محمّلة" : `خطوط ناقصة: ${missing.join(", ")}`;
}

export default function More() {
  const { theme, setTheme } = useTheme();
  const logout = async (confirmed: boolean) => {
    const service = await getSessionService();
    const result = await service.logout({ confirmed });
    if (result.needsConfirm) {
      Alert.alert("تسجيل الخروج", `${pendingLogoutMessage(result.pending)}. هل تريد الخروج؟`, [
        { text: "إلغاء", style: "cancel" },
        { text: "خروج", style: "destructive", onPress: () => void logout(true) },
      ]);
      return;
    }
    notifyBootChanged();
  };
  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl }}>
      <Row label="حالة المزامنة" onPress={() => router.push("/(tabs)/more/sync" as never)} />
      <Row label="الصندوق" onPress={() => router.push("/(tabs)/more/cashbox" as never)} />
      <Row label="الطلبيات" onPress={() => router.push("/(tabs)/more/orders" as never)} />
      <Row label="إقفال اليوم" onPress={() => router.push("/(tabs)/more/close-day" as never)} />
      <Row label="المرتجعات" onPress={() => router.push("/(tabs)/more/returns" as never)} />
      <Row label="التقارير" onPress={() => router.push("/(tabs)/more/reports" as never)} />
      <Row
        label={theme === "dark" ? "المظهر: داكن (اضغط للفاتح)" : "المظهر: فاتح (اضغط للداكن)"}
        onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
      />
      <Text testID="fonts-status" style={{ color: colors.mutedForeground, padding: spacing.sm }}>
        {fontsStatus()}
      </Text>
      <Row label="تسجيل الخروج" onPress={() => void logout(false)} />
    </ScrollView>
  );
}
