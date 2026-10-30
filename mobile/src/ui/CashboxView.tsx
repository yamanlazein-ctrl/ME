// The cashbox (FR-22): the balance per currency on a day, that day's in/out, and (for writers) a manual movement —
// capital in or a withdrawal out — saved through the desktop's use-case.
import { View } from "react-native";
import { Text } from "./Text";
import { canWriteOffline, type Role } from "../core/roles";
import { Field } from "./Field";
import { money } from "./format";
import { MoneyInput } from "./MoneyInput";
import { CURRENCY_OPTIONS } from "./SaleViews";
import { useColors } from "./themeContext-core";
import { Button, Chips, HeaderIcon, KeyValue, Notice, Screen, Section } from "./kit";

export interface CashboxViewProps {
  date: string;
  role: Role;
  balances: Record<string, number>;
  movements: Record<string, { in: number; out: number }>;
  form: { direction: "in" | "out"; currency: string; amount: number | null; description: string };
  formKey: number;
  error: string | null;
  notice: string | null;
  onDate(date: string): void;
  onShiftDay(delta: number): void;
  onForm(patch: Partial<CashboxViewProps["form"]>): void;
  onAdd(): Promise<void>;
}

export function CashboxView(p: CashboxViewProps) {
  const colors = useColors();
  const currencies = Object.keys(p.balances).sort();
  return (
    <Screen
      title="الصندوق"
      subtitle={p.date}
      headerActions={
        <>
          <HeaderIcon
            icon="chevron-forward"
            label="اليوم السابق"
            onPress={() => p.onShiftDay(-1)}
          />
          <HeaderIcon icon="chevron-back" label="اليوم التالي" onPress={() => p.onShiftDay(1)} />
        </>
      }
    >
      <Section>
        <Field
          label="التاريخ (سنة-شهر-يوم)"
          fieldId="cashbox-date"
          value={p.date}
          onChangeText={p.onDate}
        />
      </Section>
      {currencies.length === 0 ? (
        <Notice kind="info" text="لا حركات صندوق حتى هذا التاريخ." />
      ) : (
        currencies.map((c) => (
          <Section key={c} title={`الصندوق — ${c}`} testID={`cashbox-${c}`}>
            <KeyValue
              label={`الرصيد في نهاية ${p.date}`}
              value={money(p.balances[c] ?? 0, c)}
              strong
            />
            <KeyValue
              label="وارد اليوم"
              value={money(p.movements[c]?.in ?? 0, c)}
              tone="positive"
            />
            <KeyValue
              label="صادر اليوم"
              value={money(p.movements[c]?.out ?? 0, c)}
              tone="negative"
            />
          </Section>
        ))
      )}
      {canWriteOffline(p.role) ? (
        <Section title="حركة يدوية" testID="manual-movement-form" key={p.formKey}>
          <Text style={{ color: colors.mutedForeground }}>
            للحركات خارج الفواتير والسندات: إضافة رأس مال (وارد) أو سحب (صادر).
          </Text>
          <Chips<"in" | "out">
            options={[
              { value: "in", label: "وارد (رأس مال)" },
              { value: "out", label: "صادر (سحب)" },
            ]}
            value={p.form.direction}
            onChange={(direction) => p.onForm({ direction })}
            testIDPrefix="cash-direction"
          />
          <Chips
            options={CURRENCY_OPTIONS}
            value={p.form.currency}
            onChange={(currency) => p.onForm({ currency })}
            testIDPrefix="cash-currency"
          />
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
          {p.error ? <Notice kind="error" text={p.error} testID="cashbox-error" /> : null}
          {p.notice ? <Notice kind="success" text={p.notice} /> : null}
          <View>
            <Button
              label="إضافة الحركة"
              busyLabel="جارٍ الحفظ…"
              disabled={!p.form.amount}
              onPress={p.onAdd}
            />
          </View>
        </Section>
      ) : null}
    </Screen>
  );
}
