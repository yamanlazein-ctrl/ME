import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { CURRENCIES } from "./VoucherForm";
import { radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";

export interface ExpenseFormValues {
  name: string;
  amount: number | null;
  currency: string;
}

export function ExpenseForm({
  values,
  suggestions,
  error,
  busy,
  onChange,
  onSave,
}: {
  values: ExpenseFormValues;
  suggestions: string[];
  error: string | null;
  busy: boolean;
  onChange(patch: Partial<ExpenseFormValues>): void;
  onSave(): void;
}) {
  const colors = useColors();
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingTop: spacing.xl, paddingBottom: 120 }}
      >
        <Field
          label="اسم المصروف"
          fieldId="expense-name"
          value={values.name}
          onChangeText={(name) => onChange({ name })}
        />
        {suggestions.slice(0, 6).map((s) => (
          <Pressable
            key={s}
            accessibilityRole="button"
            onPress={() => onChange({ name: s })}
            style={{ minHeight: TOUCH_TARGET, justifyContent: "center" }}
          >
            <Text>{s}</Text>
          </Pressable>
        ))}
        <MoneyInput
          label="المبلغ"
          fieldId="expense-amount"
          onChangeAmount={(amount) => onChange({ amount })}
        />
        <View style={{ flexDirection: "row", gap: spacing.sm }}>
          {CURRENCIES.map((c) => (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityLabel={c}
              onPress={() => onChange({ currency: c })}
              style={{
                minHeight: TOUCH_TARGET,
                justifyContent: "center",
                paddingHorizontal: spacing.xl,
                borderRadius: radius.md,
                backgroundColor: values.currency === c ? colors.primary : colors.muted,
              }}
            >
              <Text
                style={{
                  color: values.currency === c ? colors.primaryForeground : colors.foreground,
                }}
              >
                {c}
              </Text>
            </Pressable>
          ))}
        </View>
        {error ? (
          <Text testID="expense-error" style={{ color: colors.negative }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <PrimaryActionBar
        label={busy ? "جارٍ الحفظ…" : "حفظ المصروف"}
        disabled={busy || !values.name.trim() || !values.amount}
        onPress={onSave}
      />
    </View>
  );
}
