import { Alert, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
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

export default function More() {
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
    <View style={{ padding: spacing.lg, paddingTop: spacing.xl }}>
      <Row label="حالة المزامنة" onPress={() => router.push("/(tabs)/more/sync" as never)} />
      <Row label="الصندوق" onPress={() => router.push("/(tabs)/more/cashbox" as never)} />
      <Row label="تسجيل الخروج" onPress={() => void logout(false)} />
    </View>
  );
}
