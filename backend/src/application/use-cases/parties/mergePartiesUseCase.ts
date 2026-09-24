/**
 * OLD-PLAN Phase 3.4 — merge duplicate parties into one survivor.
 * Moves invoices, vouchers, returns, ledger party_id; soft-cancels the source.
 */
import { and, eq, sql } from "drizzle-orm";
import { allowLedgerPartyRemap, type DB } from "../../../infrastructure/orm/drizzle.js";
import { parties } from "../../../infrastructure/orm/schemas/party.table.js";
import { invoices } from "../../../infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "../../../infrastructure/orm/schemas/voucher.table.js";
import { returns } from "../../../infrastructure/orm/schemas/return.table.js";
import { ledgerEntries } from "../../../infrastructure/orm/schemas/ledger-entry.table.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { BusinessRuleError } from "../../../domain/errors/index.js";

export type MergePartiesResult = {
  survivorId: string;
  sourceId: string;
  moved: { invoices: number; vouchers: number; returns: number; ledger: number };
};

export async function mergePartiesUseCase(
  db: DB,
  survivorId: string,
  sourceId: string,
  ctx: TenantContext,
): Promise<MergePartiesResult> {
  if (survivorId === sourceId) {
    throw new BusinessRuleError("لا يمكن دمج الطرف مع نفسه");
  }

  return db.transaction(async (tx) => {
    await allowLedgerPartyRemap(tx);

    const [survivor] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.id, survivorId), eq(parties.tenantId, ctx.tenantId)))
      .for("update")
      .limit(1);
    const [source] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.id, sourceId), eq(parties.tenantId, ctx.tenantId)))
      .for("update")
      .limit(1);

    if (!survivor || !source) throw new BusinessRuleError("الطرف غير موجود");
    if (survivor.kind !== source.kind) {
      throw new BusinessRuleError("لا يمكن دمج عميل مع مورد");
    }
    if (survivor.status !== "active") {
      throw new BusinessRuleError("الطرف الهدف يجب أن يكون نشطاً");
    }
    if (source.status !== "active") {
      throw new BusinessRuleError("الطرف المصدر يجب أن يكون نشطاً");
    }

    const inv = await tx
      .update(invoices)
      .set({ partyId: survivorId, updatedAt: new Date() })
      .where(and(eq(invoices.partyId, sourceId), eq(invoices.tenantId, ctx.tenantId)))
      .returning({ id: invoices.id });

    const vch = await tx
      .update(vouchers)
      .set({ partyId: survivorId, updatedAt: new Date() })
      .where(and(eq(vouchers.partyId, sourceId), eq(vouchers.tenantId, ctx.tenantId)))
      .returning({ id: vouchers.id });

    const ret = await tx
      .update(returns)
      .set({ partyId: survivorId })
      .where(and(eq(returns.partyId, sourceId), eq(returns.tenantId, ctx.tenantId)))
      .returning({ id: returns.id });

    const led = await tx
      .update(ledgerEntries)
      .set({ partyId: survivorId })
      .where(and(eq(ledgerEntries.partyId, sourceId), eq(ledgerEntries.tenantId, ctx.tenantId)))
      .returning({ id: ledgerEntries.id });

    // Soft-cancel source; rename to free unique (tenant_id, name) if needed.
    const tombstoneName = `${source.name} [مدمج→${survivor.code ?? survivor.id.slice(0, 8)}]`;
    await tx
      .update(parties)
      .set({
        status: "cancelled",
        name: tombstoneName.slice(0, 255),
        code: source.code ? `${source.code}-MERGED` : null,
        cancelledAt: new Date(),
        cancelledBy: ctx.userId,
        updatedAt: new Date(),
        version: sql`${parties.version} + 1`,
        notes: [source.notes, `Merged into ${survivorId} at ${new Date().toISOString()}`]
          .filter(Boolean)
          .join("\n"),
      })
      .where(and(eq(parties.id, sourceId), eq(parties.tenantId, ctx.tenantId)));

    return {
      survivorId,
      sourceId,
      moved: {
        invoices: inv.length,
        vouchers: vch.length,
        returns: ret.length,
        ledger: led.length,
      },
    };
  });
}
