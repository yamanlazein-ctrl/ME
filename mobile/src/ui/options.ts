// Choice lists shared by the document forms.
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "../core/lineNote";

export const CURRENCY_OPTIONS = [
  { value: "USD", label: "دولار USD" },
  { value: "SYP", label: "ليرة SYP" },
];

export const PAYMENT_OPTIONS = (Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((m) => ({
  value: m,
  label: PAYMENT_METHOD_LABEL[m],
}));
