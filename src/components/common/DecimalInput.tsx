import { useState, type ChangeEvent, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { groupThousands, isPartialDecimal, normalizeDecimalText } from "./decimalText";

type Props = Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> & {
  value: string | number | null | undefined;
  /** `e.target.value` is the clean number text ("32900.32"), like a `type="number"` input gives. */
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  allowNegative?: boolean;
  /** Digits allowed after the point: 2 for money and kg (default), 4 for per-kg prices and rates. */
  maxDecimals?: number;
};

/**
 * Drop-in replacement for `<Input type="number">` on amounts and quantities.
 *
 * A native number input rejects "32,900.32", Arabic digits and the Arabic decimal sign (٫), so
 * opening balances like 32,900.32 $ could not be typed. This is a text input with a decimal
 * keyboard that shows thousands separators and hands the caller the normalised value.
 */
export function DecimalInput({
  value,
  onChange,
  allowNegative,
  maxDecimals = 2,
  min: _min,
  max: _max,
  step: _step,
  ...rest
}: Props) {
  const [raw, setRaw] = useState<string | null>(null);
  const text = value === null || value === undefined ? "" : String(value);
  // Keep what the user is typing ("12." / "1,2") while it still means the current value; an
  // outside change (form reset, recalculation) replaces it.
  const typed = raw === null ? null : normalizeDecimalText(raw);
  const rawCurrent =
    typed !== null && (typed === text || (text !== "" && Number(typed) === Number(text)));
  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      dir="ltr"
      autoComplete="off"
      value={rawCurrent ? (raw as string) : groupThousands(text)}
      onChange={(e) => {
        const next = normalizeDecimalText(e.target.value);
        if (!isPartialDecimal(next, allowNegative, maxDecimals)) return;
        setRaw(e.target.value);
        onChange?.({
          target: { value: next },
          currentTarget: { value: next },
        } as unknown as ChangeEvent<HTMLInputElement>);
      }}
      onBlur={(e) => {
        setRaw(null);
        rest.onBlur?.(e);
      }}
    />
  );
}

DecimalInput.autoWireId = true;
