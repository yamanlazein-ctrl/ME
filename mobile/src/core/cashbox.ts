// Cashbox reads for the phone (FR-23). The desktop computes the balance at a date and the movements of a day inside
// `cashbox.route.ts`; the phone repeats that arithmetic over the same repositories (parity scenario (j) compares both).
import { round2dp } from "@erp/shared";
import type { Phone } from "./phone";

export async function cashboxState(phone: Phone) {
  return phone.repos.cashboxRepo.getState(phone.context());
}

export async function cashboxBalanceAt(
  phone: Phone,
  date: string,
  currency: string,
): Promise<number> {
  const ctx = phone.context();
  const state = await phone.repos.cashboxRepo.getState(ctx);
  const manual = await phone.repos.cashboxRepo.listManualMovements(ctx);
  const session = state.sessions.find((s) => s.currency === currency);
  const opening = session?.openingBalance ?? 0;
  const from = session?.openingDate ?? "0001-01-01";
  const ledger = await phone.repos.ledgerRepo.getCashMovementsOn(from, date, currency, ctx);
  let mIn = 0;
  let mOut = 0;
  for (const m of manual) {
    if (m.currency !== currency || m.date > date || m.date < from) continue;
    if (m.direction === "in") mIn += m.amount;
    else mOut += m.amount;
  }
  return round2dp(opening + ledger.in + mIn - ledger.out - mOut);
}

export async function cashboxBalances(phone: Phone, date: string): Promise<Record<string, number>> {
  const ctx = phone.context();
  const state = await phone.repos.cashboxRepo.getState(ctx);
  const manual = await phone.repos.cashboxRepo.listManualMovements(ctx);
  const currencies = new Set<string>(["SYP", "USD"]);
  for (const s of state.sessions) currencies.add(s.currency);
  for (const m of manual) currencies.add(m.currency);
  const out: Record<string, number> = {};
  for (const c of currencies) out[c] = await cashboxBalanceAt(phone, date, c);
  return out;
}

export async function cashboxMovementsOn(
  phone: Phone,
  date: string,
  currency: string,
): Promise<{ in: number; out: number }> {
  const ctx = phone.context();
  const [ledger, manual] = await Promise.all([
    phone.repos.ledgerRepo.getCashMovementsOn(date, date, currency, ctx),
    phone.repos.cashboxRepo.listManualMovements(ctx),
  ]);
  let mIn = 0;
  let mOut = 0;
  for (const m of manual) {
    if (m.currency !== currency || m.date !== date) continue;
    if (m.direction === "in") mIn += m.amount;
    else mOut += m.amount;
  }
  return { in: ledger.in + mIn, out: ledger.out + mOut };
}
