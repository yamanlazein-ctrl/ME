import { formatMoney } from "@/shared/utils/formatNumber";

/** "32,900.13 $" — an amount and its symbol for plain-text places (exports, labels). */
export const moneyText = (amount: number, symbol?: string) =>
  symbol ? `${formatMoney(amount)} ${symbol}` : formatMoney(amount);

const LRI = "⁦"; // LEFT-TO-RIGHT ISOLATE
const PDI = "⁩"; // POP DIRECTIONAL ISOLATE
const NB_HYPHEN = "‑"; // NON-BREAKING HYPHEN

/**
 * A date or code that must stay on one line inside an Arabic text value ("2026-10-14",
 * "CUS-2026-0001"): its hyphens become non-breaking hyphens, and the whole is a left-to-right
 * isolate — the non-breaking hyphen is bidi-neutral, so without the isolate an RTL line would print
 * the date's parts in reverse ("14-10-2026").
 */
export const keepTogether = (s: string) => `${LRI}${s.replace(/-/g, NB_HYPHEN)}${PDI}`;
