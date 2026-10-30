// The stock count sheet for the phone (FR-26): the desktop's count helpers over this phone's database. Stock reads live
// in stock.ts.
import { inventoryCountHelpers } from "@backend/infrastructure/repositories/engineHelpers";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import type { Phone } from "./phone";

export interface CountLineRow {
  rollId: string;
  countId: string | null;
  rollNo: string;
  fabricName: string;
  colorName: string;
  bookKg: number;
  countedKg: number | null;
  diffKg: number | null;
  status: string;
}

export async function loadCountSheet(
  phone: Phone,
  year: number,
  q: string,
): Promise<{ lines: CountLineRow[]; total: number }> {
  const ctx = phone.context();
  const sheet = await withTenantTx(ctx.tenantId, async (tx) =>
    (await inventoryCountHelpers()).getCountSheet(tx as never, ctx, year, {
      limit: 100,
      ...(q.trim() ? { q: q.trim() } : {}),
    }),
  );
  return {
    total: Number(sheet.total),
    lines: sheet.lines.map((l) => {
      const x = l as unknown as Record<string, unknown>;
      return {
        rollId: String(x.rollId),
        countId: (x.countId as string | null | undefined) ?? null,
        rollNo: String(x.rollNo),
        fabricName: String(x.fabricName),
        colorName: String(x.colorName),
        bookKg: Number(x.bookKg),
        countedKg: x.countedKg == null ? null : Number(x.countedKg),
        diffKg: x.diffKg == null ? null : Number(x.diffKg),
        status: String(x.status),
      };
    }),
  };
}
