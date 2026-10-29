import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { Text } from "./Text";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export interface AppLockOverlayProps {
  visible: boolean;
  /** Called when the PIN fallback is submitted; resolves true when it matches. */
  onPin(pin: string): Promise<boolean>;
  onBiometric(): void;
}

/** Opaque cover: blank in the recent-apps view (FR-41) and the lock screen when authentication is required (FR-04). */
export function AppLockOverlay({ visible, onPin, onBiometric }: AppLockOverlayProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  if (!visible) return null;
  return (
    <View
      testID="app-lock-overlay"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: colors.background,
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.xl,
      }}
    >
      <Text style={{ fontSize: fontSize.title, marginBottom: spacing.lg }}>التطبيق مقفل</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onBiometric}
        style={{
          minHeight: TOUCH_TARGET,
          justifyContent: "center",
          paddingHorizontal: spacing.xl,
          backgroundColor: colors.primary,
          borderRadius: radius.md,
          marginBottom: spacing.lg,
        }}
      >
        <Text style={{ color: colors.primaryForeground, fontSize: fontSize.body }}>
          بصمة الإصبع
        </Text>
      </Pressable>
      <TextInput
        testID="lock-pin"
        accessibilityLabel="الرمز السري"
        secureTextEntry
        keyboardType="number-pad"
        value={pin}
        onChangeText={(t) => {
          setPin(t);
          setError(false);
        }}
        onSubmitEditing={async () => {
          if (!(await onPin(pin))) {
            setError(true);
            setPin("");
          }
        }}
        style={{
          minHeight: TOUCH_TARGET,
          width: 200,
          borderWidth: 1,
          borderColor: error ? colors.negative : colors.border,
          borderRadius: radius.md,
          textAlign: "center",
          fontSize: fontSize.body,
        }}
      />
      {error ? (
        <Text style={{ color: colors.negative, marginTop: spacing.sm }}>الرمز غير صحيح</Text>
      ) : null}
    </View>
  );
}
