/**
 * Bug #1 — existing-supplier resolution for the purchase-invoice header.
 *
 * The rule lives here, outside the React component, because it is a DOMAIN
 * rule and must be provable without a browser: typing the name of a supplier
 * that already exists must resolve to THAT supplier so the operator can select
 * it, and must never let a duplicate be created.
 *
 * Matching is exact on a trimmed, case-insensitive name. A substring match is
 * deliberately not enough — "أحمد" and "أحمد محمد" are different suppliers, and
 * silently resolving one for the other would post a purchase to the wrong
 * account.
 *
 * Kept free of React and of the parties module so both the combobox and its
 * tests import exactly the same function.
 */

/** The minimum shape needed to decide "is this supplier already registered?". */
export type NameMatchable = { id: string; name: string };

function normalize(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

/**
 * The existing supplier with EXACTLY this name, or null.
 *
 * Returns null for a blank query: an empty box is "no opinion", not "this is
 * the supplier whose name is empty".
 */
export function findSupplierByExactName<T extends NameMatchable>(
  suppliers: readonly T[],
  name: string | null | undefined,
): T | null {
  const needle = normalize(name);
  if (!needle) return null;
  return suppliers.find((s) => normalize(s.name) === needle) ?? null;
}

