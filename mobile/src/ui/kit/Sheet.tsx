import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../Text";
import { fontSize, radius, spacing, TOUCH_TARGET } from "../theme";
import { useColors } from "../themeContext-core";

/**
 * A bottom sheet for a choice or a small form (pick a party, a dye lot, edit a line). The back button and the dimmed area
 * close it; nothing typed outside the sheet is lost.
 */
export function Sheet({
  visible,
  title,
  onClose,
  children,
  footer,
  testID,
  scroll = true,
}: {
  visible: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  testID?: string;
  scroll?: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Pressable
          accessibilityLabel="إغلاق"
          onPress={onClose}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            minHeight: TOUCH_TARGET,
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
        />
        <View
          {...(testID ? { testID } : {})}
          style={{
            maxHeight: "92%",
            backgroundColor: colors.background,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.border,
            paddingBottom: insets.bottom,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Text
              style={{
                flex: 1,
                fontSize: fontSize.title,
                fontWeight: "700",
                paddingVertical: spacing.md,
              }}
            >
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="إغلاق"
              testID="sheet-close"
              onPress={onClose}
              style={{
                width: TOUCH_TARGET,
                height: TOUCH_TARGET,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons name="close" size={24} color={colors.foreground} />
            </Pressable>
          </View>
          {scroll ? (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
            >
              {children}
            </ScrollView>
          ) : (
            <View style={{ padding: spacing.lg, gap: spacing.md, flexShrink: 1 }}>{children}</View>
          )}
          {footer ? (
            <View
              style={{
                padding: spacing.md,
                gap: spacing.sm,
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
            >
              {footer}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A form row that opens a picker: the label, the chosen value (or the prompt), and a chevron. */
export function PickerField({
  label,
  value,
  placeholder,
  onPress,
  testID,
  error,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  onPress(): void;
  testID?: string;
  error?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: colors.foreground }}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={value ? `${label}: ${value}` : placeholder}
        {...(testID ? { testID } : {})}
        onPress={onPress}
        style={{
          minHeight: TOUCH_TARGET,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: spacing.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: error ? colors.negative : colors.input,
          backgroundColor: colors.card,
          gap: spacing.sm,
        }}
      >
        <Text style={{ flex: 1, color: value ? colors.foreground : colors.mutedForeground }}>
          {value ?? placeholder}
        </Text>
        <Ionicons name="chevron-down" size={18} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}
