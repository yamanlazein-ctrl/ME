import { useEffect, useState } from "react";
import { Keyboard, Pressable, View } from "react-native";
import { Text } from "./Text";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export interface PrimaryActionBarProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** The screen's main action: fixed at the bottom within thumb reach and lifted above the keyboard (UX-02). */
export function PrimaryActionBar({ label, onPress, disabled = false }: PrimaryActionBarProps) {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(
      "keyboardDidShow",
      (e: { endCoordinates?: { height: number } }) =>
        setKeyboardHeight(e.endCoordinates?.height ?? 0),
    );
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return (
    <View
      testID="primary-action-bar"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: keyboardHeight,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: spacing.lg,
        backgroundColor: colors.background,
        borderTopWidth: 1,
        borderTopColor: colors.border,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={{
          minHeight: TOUCH_TARGET,
          borderRadius: radius.lg,
          backgroundColor: disabled ? colors.input : colors.primary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.primaryForeground, fontSize: fontSize.button }}>{label}</Text>
      </Pressable>
    </View>
  );
}
