// Receipt (سند قبض: money IN from a customer) and payment (سند صرف: money OUT to a supplier) (FR-20, FR-21). The title says
// which way the money goes; the party's balance is shown before and after; the rate is asked only for a non-USD voucher
// (the desktop's rule) and never pre-filled; refusals from the use-case (insufficient cash, locked day, closed year) are
// shown as the use-case wrote them (E10, E11).
import { saneSypRateError } from "@erp/shared";
import { View } from "react-native";
import { Text } from "./Text";
import { balanceSideLabel, type CurrencyBalance } from "../core/parties";
import { Field } from "./Field";
import { money } from "./format";
import { MoneyInput } from "./MoneyInput";
import { PartyPicker, type PickedParty } from "./PartyPicker";
import { CURRENCY_OPTIONS } from "./SaleViews";
import { useColors } from "./themeContext-core";
import { Button, Chips, KeyValue, Notice, Screen, Section } from "./kit";

export const CURRENCIES = ["USD", "SYP"] as const;

export type VoucherMethod = "cash" | "transfer" | "check";

export const METHOD_OPTIONS: Array<{ value: VoucherMethod; label: string }> = [
  { value: "cash", label: "نقدي" },
  { value: "transfer", label: "تحويل بنكي" },
  { value: "check", label: "شيك" },
];

export interface VoucherFormValues {
  party: PickedParty | null;
  amount: number | null;
  currency: string;
  rate: number | null;
  discount: number | null;
  method: VoucherMethod;
  note: string;
}

export function emptyVoucher(): VoucherFormValues {
  return {
    party: null,
    amount: null,
    currency: "USD",
    rate: null,
    discount: null,
    method: "cash",
    note: "",
  };
}

export type VoucherProblem = "no-party" | "no-amount" | "no-rate" | "bad-rate";

export const VOUCHER_PROBLEM_TEXT: Record<VoucherProblem, string> = {
  "no-party": "اختر الطرف",
  "no-amount": "اكتب المبلغ",
  "no-rate": "سعر الصرف مطلوب لكل سند ليس بالدولار",
  "bad-rate": "سعر الصرف غير منطقي لليرة السورية (أقل من 1,000) — تأكد من الأصفار",
};

export function voucherProblems(v: VoucherFormValues): VoucherProblem[] {
  const out: VoucherProblem[] = [];
  if (!v.party) out.push("no-party");
  if (!(v.amount && v.amount > 0)) out.push("no-amount");
  if (v.currency !== "USD" && !(v.rate && v.rate > 0)) out.push("no-rate");
  if (saneSypRateError(v.currency, v.rate)) out.push("bad-rate");
  return out;
}

/** The balance in the voucher's currency after it: a receipt lowers what a customer owes, a payment what we owe. */
export function balanceAfter(
  before: CurrencyBalance | undefined,
  amount: number,
  discount: number,
  kind: "receipt" | "payment",
): number {
  void kind; // both directions settle the party's balance in its own sign convention (statement totals)
  // Customer: positive = owes us, a receipt (and its allowed discount) subtracts. Supplier: positive = we owe, a payment
  // subtracts.
  return Math.round(((before?.balance ?? 0) - amount - discount) * 100) / 100;
}

export function VoucherForm({
  kind,
  amend,
  values,
  balances,
  error,
  attempted,
  initialAmount,
  onChange,
  onSave,
}: {
  kind: "receipt" | "payment";
  amend?: boolean;
  values: VoucherFormValues;
  /** The chosen party's balances (undefined while loading or before a party is chosen). */
  balances: CurrencyBalance[] | undefined;
  error: string | null;
  attempted: boolean;
  initialAmount?: string;
  onChange(patch: Partial<VoucherFormValues>): void;
  onSave(): Promise<void>;
}) {
  const colors = useColors();
  const receipt = kind === "receipt";
  const partyKind = receipt ? "customer" : "supplier";
  const problems = voucherProblems(values);
  const show = (k: VoucherProblem) => attempted && problems.includes(k);
  const before = balances?.find((b) => b.currency === values.currency);
  const after =
    values.party && values.amount
      ? balanceAfter(before, values.amount, values.discount ?? 0, kind)
      : null;
  const afterText = (v: number) =>
    `${money(Math.abs(v), values.currency)} ${
      Math.abs(v) < 0.01
        ? "متوازن"
        : balanceSideLabel(v > 0 === (partyKind === "customer") ? "debit" : "credit", partyKind)
    }`;
  const title = amend
    ? receipt
      ? "تعديل سند قبض"
      : "تعديل سند صرف"
    : receipt
      ? "سند قبض"
      : "سند صرف";
  return (
    <Screen
      title={title}
      subtitle={receipt ? "استلام مال من عميل" : "دفع مال إلى مورد"}
      footerNotice={
        <>
          {attempted && problems.length > 0 ? (
            <Notice
              kind="error"
              text={problems.map((p) => VOUCHER_PROBLEM_TEXT[p]).join("\n")}
              testID="voucher-problems"
            />
          ) : null}
          {error ? <Notice kind="error" text={error} testID="voucher-error" /> : null}
          {/* The figure to check before saving: right above the button, never below the fold. */}
          {values.party && balances && after !== null ? (
            <KeyValue
              label="الرصيد بعد السند"
              strong
              value={afterText(after)}
              testID="voucher-balance-after"
            />
          ) : null}
        </>
      }
      footer={
        <Button
          label={amend ? "حفظ التعديل" : receipt ? "حفظ سند القبض" : "حفظ سند الصرف"}
          busyLabel="جارٍ الحفظ…"
          testID="voucher-save"
          onPress={onSave}
        />
      }
    >
      <Notice
        kind="info"
        text={
          receipt
            ? "يُسجَّل المبلغ داخلاً إلى الصندوق ويُخفّض ما على العميل."
            : "يُسجَّل المبلغ خارجاً من الصندوق ويُخفّض ما للمورد علينا."
        }
      />
      <Section>
        <PartyPicker
          kind={partyKind}
          label={receipt ? "استلمنا من" : "دفعنا إلى"}
          value={values.party}
          onPick={(party) => onChange({ party })}
          error={show("no-party")}
        />
        <MoneyInput
          label="المبلغ"
          fieldId="voucher-amount"
          initialText={initialAmount ?? ""}
          error={show("no-amount") ? VOUCHER_PROBLEM_TEXT["no-amount"] : null}
          onChangeAmount={(amount) => onChange({ amount })}
        />
        <Chips
          options={CURRENCY_OPTIONS}
          value={values.currency}
          onChange={(currency) => onChange({ currency })}
          testIDPrefix="voucher-currency"
        />
        {values.currency !== "USD" ? (
          <MoneyInput
            label="سعر الصرف (ليرة لكل 1 دولار)"
            fieldId="voucher-rate"
            initialText={values.rate ? String(values.rate) : ""}
            error={
              show("no-rate")
                ? VOUCHER_PROBLEM_TEXT["no-rate"]
                : show("bad-rate")
                  ? VOUCHER_PROBLEM_TEXT["bad-rate"]
                  : null
            }
            onChangeAmount={(rate) => onChange({ rate })}
          />
        ) : null}
        <Text style={{ color: colors.foreground }}>
          {receipt ? "طريقة الاستلام" : "طريقة الدفع"}
        </Text>
        <Chips
          options={METHOD_OPTIONS}
          value={values.method}
          onChange={(method) => onChange({ method })}
          testIDPrefix="voucher-method"
        />
        <MoneyInput
          label="خصم مسموح (اختياري)"
          fieldId="voucher-discount"
          onChangeAmount={(discount) => onChange({ discount })}
        />
        <Field
          label="ملاحظة (اختياري)"
          fieldId="voucher-note"
          value={values.note}
          onChangeText={(note) => onChange({ note })}
        />
      </Section>
      {values.party ? (
        <Section title={`رصيد ${values.party.name} — ${values.currency}`} testID="voucher-balance">
          {balances ? (
            <>
              <KeyValue
                label="قبل السند"
                value={`${money(Math.abs(before?.balance ?? 0), values.currency)} ${before ? balanceSideLabel(before.side, partyKind) : ""}`.trim()}
              />
            </>
          ) : (
            <View>
              <Text style={{ color: colors.mutedForeground }}>جارٍ حساب الرصيد…</Text>
            </View>
          )}
        </Section>
      ) : null}
    </Screen>
  );
}
