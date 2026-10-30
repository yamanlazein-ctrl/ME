import { formatAmount } from "./money";

/** "1,250.50 كغ" */
export function kg(value: number): string {
  return `${formatAmount(value)} كغ`;
}

/** "12 ثوب" */
export function piecesText(n: number): string {
  return `${n} ثوب`;
}

/** "1,250.50 USD" */
export function money(amount: number, currency: string): string {
  return `${formatAmount(amount)} ${currency}`;
}
