/** Approximate invoice line groups per A4 page (main row + optional detail). */
export const INVOICE_LINES_PER_PRINT_PAGE = 10;

export function chunkArray<T>(items: readonly T[], size: number): readonly T[][] {
  if (size <= 0 || items.length === 0) return items.length === 0 ? [] : [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
