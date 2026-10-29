import { Pressable, ScrollView, View } from "react-native";
import { Text } from "./Text";
import { canWriteOffline, type Role } from "../core/roles";
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { MoneyText } from "./MoneyText";
import { PrimaryActionBar } from "./PrimaryActionBar";
import { radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";

export interface CashboxViewProps {
  date: string;
  role: Role;
  balances: Record<string, number>;
  movements: Record<string, { in: number; out: number }>;
  form: { direction: "in" | "out"; currency: string; amount: number | null; description: string };
  error: string | null;
  onDate(date: string): void;
  onShiftDay(delta: number): void;
  onForm(patch: Partial<CashboxViewProps["form"]>): void;
  onAdd(): void;
}

export function CashboxView(p: CashboxViewProps) {
  const colors = useColors();
  const currencies = Object.keys(p.balances).sort();
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="اليوم السابق"
            onPress={() => p.onShiftDay(-1)}
            style={{ minHeight: TOUCH_TARGET, justifyContent: "center", padding: spacing.md }}
          >
            <Text>›</Text>
          </Pressable>
          <Field label="التاريخ" fieldId="cashbox-date" value={p.date} onChangeText={p.onDate} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="اليوم التالي"
            onPress={() => p.onShiftDay(1)}
            style={{ minHeight: TOUCH_TARGET, justifyContent: "center", padding: spacing.md }}
          >
            <Text>‹</Text>
          </Pressable>
        </View>
        {currencies.map((c) => (
          <View
            key={c}
            testID={`cashbox-${c}`}
            style={{
              backgroundColor: colors.card,
              borderRadius: radius.lg,
              padding: spacing.lg,
              marginBottom: spacing.md,
            }}
          >
            <Text
              style={{ color: colors.mutedForeground }}
            >{`الرصيد بتاريخ ${p.date} — ${c}`}</Text>
            <MoneyText amount={p.balances[c] ?? 0} currency={c} />
            <Text>{`وارد اليوم ${p.movements[c]?.in ?? 0} · صادر ${p.movements[c]?.out ?? 0}`}</Text>
          </View>
        ))}
        {canWriteOffline(p.role) ? (
          <View testID="manual-movement-form">
            <Text style={{ marginTop: spacing.lg }}>حركة يدوية</Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md }}>
              {(["in", "out"] as const).map((d) => (
                <Pressable
                  key={d}
                  accessibilityRole="button"
                  accessibilityLabel={d === "in" ? "وارد" : "صادر"}
                  onPress={() => p.onForm({ direction: d })}
                  style={{
                    minHeight: TOUCH_TARGET,
                    justifyContent: "center",
                    paddingHorizontal: spacing.xl,
                    borderRadius: radius.md,
                    backgroundColor: p.form.direction === d ? colors.primary : colors.muted,
                  }}
                >
                  <Text
                    style={{
                      color: p.form.direction === d ? colors.primaryForeground : colors.foreground,
                    }}
                  >
                    {d === "in" ? "وارد" : "صادر"}
                  </Text>
                </Pressable>
              ))}
              {["USD", "SYP"].map((c) => (
                <Pressable
                  key={c}
                  accessibilityRole="button"
                  accessibilityLabel={`عملة ${c}`}
                  onPress={() => p.onForm({ currency: c })}
                  style={{
                    minHeight: TOUCH_TARGET,
                    justifyContent: "center",
                    paddingHorizontal: spacing.lg,
                    borderRadius: radius.md,
                    backgroundColor: p.form.currency === c ? colors.primary : colors.muted,
                  }}
                >
                  <Text
                    style={{
                      color: p.form.currency === c ? colors.primaryForeground : colors.foreground,
                    }}
                  >
                    {c}
                  </Text>
                </Pressable>
              ))}
            </View>
            <MoneyInput
              label="المبلغ"
              fieldId="cashbox-amount"
              onChangeAmount={(amount) => p.onForm({ amount })}
            />
            <Field
              label="الوصف"
              fieldId="cashbox-desc"
              value={p.form.description}
              onChangeText={(description) => p.onForm({ description })}
            />
            {p.error ? (
              <Text testID="cashbox-error" style={{ color: colors.negative }}>
                {p.error}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      {canWriteOffline(p.role) ? (
        <PrimaryActionBar label="إضافة حركة" disabled={!p.form.amount} onPress={p.onAdd} />
      ) : null}
    </View>
  );
}
