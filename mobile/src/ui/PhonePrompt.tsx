// Asked when the party has no saved phone (E13): type a number, optionally save it on the party, and send.
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { Field } from "./Field";
import { colors, radius, spacing, TOUCH_TARGET } from "./theme";

export function PhonePrompt({
  partyName,
  value,
  save,
  busy,
  error,
  onChange,
  onToggleSave,
  onSend,
  onCancel,
}: {
  partyName: string;
  value: string;
  save: boolean;
  busy: boolean;
  error: string | null;
  onChange(v: string): void;
  onToggleSave(): void;
  onSend(): void;
  onCancel(): void;
}) {
  return (
    <View
      testID="phone-prompt"
      style={{
        marginTop: spacing.md,
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text>{`لا يوجد رقم هاتف محفوظ لـ ${partyName}. اكتب رقم واتساب العميل.`}</Text>
      <Field
        label="رقم الهاتف"
        fieldId="send-phone"
        value={value}
        onChangeText={onChange}
        keyboardType="phone-pad"
      />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="حفظ الرقم في بطاقة العميل"
        accessibilityState={{ checked: save }}
        onPress={onToggleSave}
        style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
      >
        <Text>{`${save ? "☑" : "☐"} حفظ الرقم في بطاقة العميل`}</Text>
      </Pressable>
      {error ? (
        <Text testID="send-error" style={{ color: colors.negative }}>
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="إرسال"
          disabled={busy || value.trim().length === 0}
          onPress={onSend}
          style={{
            flex: 1,
            minHeight: TOUCH_TARGET,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: radius.md,
            backgroundColor: value.trim().length === 0 ? colors.muted : colors.primary,
          }}
        >
          <Text style={{ color: colors.primaryForeground }}>
            {busy ? "جارٍ الإرسال…" : "إرسال"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="إلغاء الإرسال"
          onPress={onCancel}
          style={{ minHeight: TOUCH_TARGET, justifyContent: "center", padding: spacing.md }}
        >
          <Text>إلغاء</Text>
        </Pressable>
      </View>
    </View>
  );
}
