import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

const FRAME = 240;

export interface ScanOverlayProps {
  /** Shown under the frame: the hint, or why the last code was not accepted. */
  message: string;
  rejected: boolean;
  onCancel(): void;
}

/** Drawn over the camera: a square frame, a one-line hint and a cancel button. */
export function ScanOverlay({ message, rejected, onCancel }: ScanOverlayProps) {
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        testID="scan-frame"
        style={{
          width: FRAME,
          height: FRAME,
          borderWidth: 3,
          borderRadius: radius.lg,
          borderColor: rejected ? colors.negative : colors.primary,
        }}
      />
      <Text
        testID="scan-message"
        style={{
          marginTop: spacing.lg,
          paddingHorizontal: spacing.lg,
          textAlign: "center",
          fontSize: fontSize.body,
          color: "#ffffff",
        }}
      >
        {message}
      </Text>
      <Pressable
        testID="scan-cancel"
        accessibilityRole="button"
        accessibilityLabel="إلغاء"
        onPress={onCancel}
        style={{
          position: "absolute",
          bottom: spacing.xl,
          minHeight: TOUCH_TARGET,
          minWidth: 160,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Text>إلغاء</Text>
      </Pressable>
    </View>
  );
}

/** Shown instead of the camera when the camera permission was refused. */
export function ScanDenied({ onCancel, children }: { onCancel(): void; children?: ReactNode }) {
  return (
    <View style={{ flex: 1, padding: spacing.lg, paddingTop: 64 }}>
      <Text testID="scan-denied" style={{ fontSize: fontSize.title, marginBottom: spacing.md }}>
        لا يوجد إذن للكاميرا
      </Text>
      <Text>
        اسمح للتطبيق باستخدام الكاميرا من إعدادات الهاتف، أو اكتب عنوان المركز والرمز يدوياً.
      </Text>
      {children}
      <Pressable
        accessibilityRole="button"
        onPress={onCancel}
        style={{
          minHeight: TOUCH_TARGET,
          marginTop: spacing.lg,
          justifyContent: "center",
          alignItems: "center",
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
        }}
      >
        <Text>رجوع</Text>
      </Pressable>
    </View>
  );
}
