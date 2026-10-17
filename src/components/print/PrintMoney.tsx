import { formatMoney } from "@/shared/utils/formatNumber";

/**
 * An amount with its currency symbol as ONE left-to-right unit, isolated from the RTL row, so the
 * digits and "ل.س" / "$" never reorder or run into the neighbouring cell.
 */
export function Money({ amount, symbol }: { amount: number; symbol?: string }) {
  return (
    <span className="pd-money-unit" dir="ltr">
      {/* explicit ltr, not <bdi>: a digits-only run has no strong letter, and "auto" resolved it
          to the surrounding RTL, printing a negative balance as "1,250,000-" */}
      <span dir="ltr">{formatMoney(amount)}</span>
      {symbol ? <span className="pd-ccy">{symbol}</span> : null}
    </span>
  );
}
