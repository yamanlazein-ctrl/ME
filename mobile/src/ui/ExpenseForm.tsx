// An expense paid from the cashbox (FR-23): its name (with names used before), amount and currency.
import { Field } from "./Field";
import { MoneyInput } from "./MoneyInput";
import { CURRENCY_OPTIONS } from "./SaleViews";
import { Button, Chips, Notice, Screen, Section } from "./kit";

export interface ExpenseFormValues {
  name: string;
  amount: number | null;
  currency: string;
}

export function ExpenseForm({
  values,
  suggestions,
  error,
  onChange,
  onSave,
}: {
  values: ExpenseFormValues;
  suggestions: string[];
  error: string | null;
  onChange(patch: Partial<ExpenseFormValues>): void;
  onSave(): Promise<void> | void;
}) {
  return (
    <Screen
      title="مصروف"
      subtitle="يُدفع من الصندوق"
      footerNotice={
        <>{error ? <Notice kind="error" text={error} testID="expense-error" /> : null}</>
      }
      footer={
        <Button
          label="حفظ المصروف"
          busyLabel="جارٍ الحفظ…"
          disabled={!values.name.trim() || !values.amount}
          onPress={onSave}
          testID="expense-save"
        />
      }
    >
      <Section>
        <Field
          label="اسم المصروف"
          fieldId="expense-name"
          value={values.name}
          placeholder="نقل، كهرباء، أجور…"
          onChangeText={(name) => onChange({ name })}
        />
        {suggestions.length > 0 ? (
          <Chips
            options={suggestions.slice(0, 6).map((s) => ({ value: s, label: s }))}
            value=""
            onChange={(name) => onChange({ name })}
            testIDPrefix="expense-suggest"
          />
        ) : null}
        <MoneyInput
          label="المبلغ"
          fieldId="expense-amount"
          onChangeAmount={(amount) => onChange({ amount })}
        />
        <Chips
          options={CURRENCY_OPTIONS}
          value={values.currency}
          onChange={(currency) => onChange({ currency })}
          testIDPrefix="expense-currency"
        />
      </Section>
    </Screen>
  );
}
