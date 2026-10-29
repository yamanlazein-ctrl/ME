import { useState } from "react";
import { Field, type FieldProps } from "./Field";
import { normalizeTyping, parseTypedAmount } from "./money";

export interface MoneyInputProps extends Omit<
  FieldProps,
  "value" | "onChangeText" | "keyboardType"
> {
  /** Called with the number typed so far, or null when the field is empty. */
  onChangeAmount: (amount: number | null) => void;
  initialText?: string;
}

/** Numeric keypad, thousands separators while typing, at most 2 decimals (`hasMoreThan2dp`, UX-08). */
export function MoneyInput({ onChangeAmount, initialText = "", ...field }: MoneyInputProps) {
  const [text, setText] = useState(initialText);
  return (
    <Field
      {...field}
      keyboardType="decimal-pad"
      inputMode="decimal"
      value={text}
      onChangeText={(next) => {
        const normalized = normalizeTyping(next);
        if (normalized === null) return; // a third decimal or a non-numeric character is refused
        setText(normalized);
        onChangeAmount(parseTypedAmount(normalized));
      }}
    />
  );
}
