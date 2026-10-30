import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../Text";
import { fontSize, radius, spacing, TOUCH_TARGET } from "../theme";
import { useColors } from "../themeContext-core";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps {
  label: string;
  onPress: () => unknown;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Shown instead of the label while `busy` (or while an async onPress runs). */
  busyLabel?: string;
  busy?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
  /** Stretch to the row width (default true). */
  block?: boolean;
}

/**
 * The one button of the app. An async `onPress` locks the button until it settles, so a second tap can never create a
 * second document (the use-cases are idempotent per opId too; this stops the second request being made at all).
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  busyLabel,
  busy: busyProp = false,
  icon,
  testID,
  block = true,
}: ButtonProps) {
  const colors = useColors();
  const [running, setRunning] = useState(false);
  const lock = useRef(false);
  const busy = busyProp || running;
  const inactive = disabled || busy;
  const palette = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: colors.primary },
    secondary: { bg: colors.card, fg: colors.foreground, border: colors.input },
    danger: { bg: colors.card, fg: colors.negative, border: colors.negative },
    ghost: { bg: "transparent", fg: colors.primary, border: "transparent" },
  }[variant];
  const press = () => {
    if (lock.current || inactive) return;
    const result = onPress();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      lock.current = true;
      setRunning(true);
      void (result as Promise<unknown>).finally(() => {
        lock.current = false;
        setRunning(false);
      });
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      {...(testID ? { testID } : {})}
      disabled={inactive}
      onPress={press}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET,
        alignSelf: block ? "stretch" : "flex-start",
        paddingHorizontal: spacing.lg,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.bg,
        opacity: disabled && !busy ? 0.45 : pressed ? 0.8 : 1,
        alignItems: "center",
        justifyContent: "center",
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        {busy ? (
          <ActivityIndicator color={palette.fg} />
        ) : icon ? (
          <Ionicons name={icon} size={20} color={palette.fg} />
        ) : null}
        <Text style={{ color: palette.fg, fontSize: fontSize.button, fontWeight: "600" }}>
          {busy && busyLabel ? busyLabel : label}
        </Text>
      </View>
    </Pressable>
  );
}
