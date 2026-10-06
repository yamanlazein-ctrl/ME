/**
 * RS-5 restore comparison (specs/001-desktop-sqlite-engine T091/T098/T099).
 *
 * The business figures a user would check after a restore — record counts, parties, invoices,
 * per-party balances, ledger totals, inventory, cash box — computed exactly (scaled integers, no
 * floating point) on two databases. A restore proceeds only when the staging copy (after any
 * migration) shows exactly the figures of the verified archive.
 */
import Database from "better-sqlite3";
import { businessTables } from "./sqliteBackup.js";

export type Rs5Figures = Record<string, string>;

const FIGURES: Array<[string, string]> = [
  ["parties by kind/status", "SELECT kind || '/' || status AS k, count(*) AS v FROM parties GROUP BY 1"],
  ["invoices by type/currency/status (count, total, paid)", "SELECT type || '/' || currency || '/' || status AS k, count(*) || ':' || sum(total) || ':' || sum(paid) AS v FROM invoices GROUP BY 1"],
  ["vouchers by kind/currency/status", "SELECT kind || '/' || currency || '/' || status AS k, count(*) || ':' || sum(amount) AS v FROM vouchers GROUP BY 1"],
  ["returns by kind/status", "SELECT kind || '/' || status AS k, count(*) AS v FROM returns GROUP BY 1"],
  ["ledger by currency/status (debit, credit)", "SELECT currency || '/' || status AS k, count(*) || ':' || sum(debit) || ':' || sum(credit) AS v FROM ledger_entries GROUP BY 1"],
  ["party balances", "SELECT coalesce(party_id, '-') || '/' || currency AS k, sum(debit) - sum(credit) AS v FROM ledger_entries WHERE status = 'active' GROUP BY 1"],
  ["inventory by currency/status (rolls, kg)", "SELECT currency || '/' || status AS k, count(*) || ':' || sum(remaining_kg) || ':' || sum(remaining_pieces) AS v FROM rolls GROUP BY 1"],
  ["cash box closing by currency/day", "SELECT currency || '/' || balance_date AS k, closing_balance AS v FROM cashbox_daily_balances"],
  ["manual movements by currency/direction", "SELECT currency || '/' || direction AS k, count(*) || ':' || sum(amount) AS v FROM manual_movements GROUP BY 1"],
];

export function rs5Figures(dbPath: string): Rs5Figures {
  const db = new Database(dbPath, { readonly: true });
  try {
    const out: Rs5Figures = {};
    for (const t of businessTables(db)) out[`rows:${t}`] = String(db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get());
    for (const [name, q] of FIGURES) {
      for (const r of db.prepare(q).safeIntegers(true).all() as Array<{ k: string; v: unknown }>) {
        out[`${name}:${r.k}`] = String(r.v);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

/** Differences between two figure sets; empty = identical. */
export function rs5Diff(expected: Rs5Figures, actual: Rs5Figures): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const out: string[] = [];
  // A table that exists on one side only (added or dropped by a migration between the archive and
  // this app) holds no rows there: its count compares as "0", so an empty new table is not a loss.
  const value = (f: Rs5Figures, k: string) => f[k] ?? (k.startsWith("rows:") ? "0" : undefined);
  for (const k of [...keys].sort()) {
    if (value(expected, k) !== value(actual, k)) out.push(`${k}: expected ${expected[k] ?? "∅"}, got ${actual[k] ?? "∅"}`);
  }
  return out;
}
