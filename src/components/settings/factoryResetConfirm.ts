/**
 * Field incident (2026-09): a one-click factory reset sat next to "فصل" on the
 * sync page; the next launch silently deleted pgdata — invoices and stock
 * vanished and only the part already pushed to the hub came back on pull.
 * A reset now needs the exact phrase typed, and the Rust side moves pgdata
 * aside (pgdata.reset-<time>) instead of deleting it.
 */
export const FACTORY_RESET_PHRASE = "احذف كل البيانات";

export function canConfirmFactoryReset(typed: string): boolean {
  return typed.trim() === FACTORY_RESET_PHRASE;
}
