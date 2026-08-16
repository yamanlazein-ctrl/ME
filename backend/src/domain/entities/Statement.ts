import type { UUID, LedgerType, PartyKind } from "../types/index.js";

/**
 * A single expandable line inside a statement row (typically an invoice).
 */
export interface StatementLineDetail {
  fabricId: UUID;
  fabricName: string;
  colorId: UUID;
  colorName: string;
  rollId: UUID;
  rollNo?: string | null;
  quantityKg: number;
  pricePerKg: number;
  amount: number;
}

/**
 * One statement row. Entries are chronological (date ASC, createdAt ASC) and
 * each row carries its running balance so the UI never has to re-accumulate.
 *
 * Cancelled movements (`status = "cancelled"`) are always present in the
 * register (they must never be dropped from the query) but they are excluded
 * from previousBalance/runningBalance/totals. The UI strikes them through.
 */
export interface StatementEntryData {
  id: UUID;
  seq: number;
  date: string;
  type: LedgerType;
  status: "active" | "cancelled";
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  description?: string;
  quantityKg?: number;
  pricePerKg?: number;
  debit: number;
  credit: number;
  runningBalance: number;
  lines?: StatementLineDetail[];
}

/**
 * Full party statement: header party metadata + filters echo + totals.
 * previousBalance: sum of signed movements strictly before fromDate.
 * finalBalance: previousBalance + (totalDebit − totalCredit) for a customer,
 * or previousBalance + (totalCredit − totalDebit) for a supplier.
 */
export interface PartyStatementData {
  partyId: UUID;
  partyName: string;
  partyCode?: string | null;
  kind: PartyKind;
  currency: string;
  fromDate?: string | null;
  toDate?: string | null;
  type?: string | null;
  previousBalance: number;
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
  entries: StatementEntryData[];
}

export interface StatementQuery {
  partyId: UUID;
  kind: PartyKind;
  fromDate?: string;
  toDate?: string;
  currency?: string;
  type?: string;
}