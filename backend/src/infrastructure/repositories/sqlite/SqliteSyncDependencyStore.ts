// PORTED-FROM: src/infrastructure/repositories/PostgresSyncDependencyStore.ts sha256=e78f30c7c67f51e169f5caf89378ad035afdd69a919079e8e40793069ce9db13
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
﻿/**
 * PostgreSQL SQL for sync dependency replay — moved verbatim from
 * syncDependencySnapshots.ts (S1). The application rules it needs (tombstone
 * guard, number-collision resolution) are passed in as hooks so this module
 * never imports application code.
 */
import { and, eq } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import { runWithTenantContext } from "../../orm/tenant-context.js";
import { parties } from "../../orm/sqlite/schemas/party.table.js";
import { fabrics } from "../../orm/sqlite/schemas/fabric.table.js";
import { colors } from "../../orm/sqlite/schemas/color.table.js";
import { rolls } from "../../orm/sqlite/schemas/roll.table.js";
import { recordStockMovement } from "./helpers/stockMovementHelper.js";
import { ledgerEntries } from "../../orm/sqlite/schemas/ledger-entry.table.js";
import { openingJournalRows } from "./SqlitePartyRepository.js";
import { logger } from "../../config/logger.js";
import type {
  DependencyReplayHooks,
  ISyncDependencyStore,
  ReplayDependencies,
  ReplayPartySnapshot,
} from "../../../application/ports/ISyncDependencyStore.js";
import type { TenantContext } from "../../../domain/types/index.js";

type Tx = DB;

export const sqliteSyncDependencyStore: ISyncDependencyStore = {
  async applyPartyOpening(executor: unknown, snap: ReplayPartySnapshot, ctx: TenantContext, amount: number, date: string): Promise<void> {
    const database = executor as DB;
    await runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      await database.transaction(async (tx) => {
        const existing = await tx
          .select({ id: ledgerEntries.id })
          .from(ledgerEntries)
          .where(
            and(
              eq(ledgerEntries.tenantId, ctx.tenantId),
              eq(ledgerEntries.referenceType, "opening"),
              eq(ledgerEntries.referenceId, snap.id),
            ),
          )
          .limit(1);
        if (existing.length > 0) return;
        const [party] = await tx
          .select({ id: parties.id, code: parties.code, kind: parties.kind, currency: parties.currency })
          .from(parties)
          .where(and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, snap.id)))
          .limit(1);
        if (!party) return;
        await tx
          .update(parties)
          .set({
            openingCurrency: snap.openingCurrency ?? null,
            openingDate: date,
            openingNote: snap.openingNote ?? null,
            openingBalance: String(amount) as never,
          })
          .where(and(eq(parties.tenantId, ctx.tenantId), eq(parties.id, snap.id)));
        await tx.insert(ledgerEntries).values(
          openingJournalRows({
            tenantId: ctx.tenantId,
            partyId: party.id,
            kind: party.kind,
            openingBalance: amount,
            currency: snap.openingCurrency ?? party.currency,
            code: party.code ?? null,
            date,
            note: snap.openingNote ?? null,
            userId: ctx.userId,
          }),
        );
      });
    });
  },

  async ensureDependenciesInTx(executor: unknown, deps: ReplayDependencies, ctx: TenantContext, hooks: DependencyReplayHooks): Promise<void> {
    const tx = executor as Tx;

    for (const p of deps.parties ?? []) {
      const [existing] = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.id, p.id), eq(parties.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      // §10: never resurrect a deleted master through a dependency snapshot.
      if (await hooks.tombstoneBlocks(ctx.tenantId, "party", p.id)) continue;
      // Same code/name on a different party (created on another device before
      // sync): deterministic suffix, never an endless refusal.
      await hooks.resolveMaster(tx, "party", p as unknown as Record<string, unknown>, ctx.tenantId);
      try {
        await tx.insert(parties).values({
          id: p.id,
          tenantId: ctx.tenantId,
          kind: p.kind,
          code: p.code ?? null,
          name: p.name,
          companyName: p.companyName ?? null,
          commercialReg: p.commercialReg ?? null,
          category: p.category ?? null,
          salesRep: p.salesRep ?? null,
          phone: p.phone ?? null,
          mobile: p.mobile ?? null,
          whatsapp: p.whatsapp ?? null,
          altPhone: p.altPhone ?? null,
          email: p.email ?? null,
          website: p.website ?? null,
          address: p.address ?? null,
          city: p.city ?? null,
          country: p.country ?? null,
          taxNumber: p.taxNumber ?? null,
          // Opening balance is not re-journaled here — invoice ledger legs carry AR/AP.
          openingBalance: 0,
          creditLimit: 0,
          currency: p.currency || "SYP",
          paymentTerms: p.paymentTerms ?? null,
          paymentMethod: p.paymentMethod ?? null,
          defaultDiscount: p.defaultDiscount ?? 0,
          vat: p.vat != null ? String(p.vat) : "0",
          status: p.status || "active",
          notes: p.notes ?? null,
          createdBy: ctx.userId,
        }).onConflictDoNothing({ target: parties.id });
      } catch (err) {
        logger.warn(
          { err, partyId: p.id },
          "sync party insert skipped (likely natural-key conflict)",
        );
        throw err;
      }
    }

    for (const f of deps.fabrics ?? []) {
      const [existing] = await tx
        .select({ id: fabrics.id })
        .from(fabrics)
        .where(and(eq(fabrics.id, f.id), eq(fabrics.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      if (await hooks.tombstoneBlocks(ctx.tenantId, "fabric", f.id)) continue;
      await hooks.resolveMaster(tx, "fabric", f as unknown as Record<string, unknown>, ctx.tenantId);
      await tx.insert(fabrics).values({
        id: f.id,
        tenantId: ctx.tenantId,
        name: f.name,
        category: f.category ?? null,
        minStockKg: f.minStockKg != null ? String(f.minStockKg) : "0",
        unit: f.unit ?? null,
        notes: f.notes ?? null,
        imageUrl: f.imageUrl ?? null,
        createdBy: ctx.userId,
      }).onConflictDoNothing({ target: fabrics.id });
    }

    for (const c of deps.colors ?? []) {
      const [existing] = await tx
        .select({ id: colors.id })
        .from(colors)
        .where(and(eq(colors.id, c.id), eq(colors.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      if (await hooks.tombstoneBlocks(ctx.tenantId, "color", c.id)) continue;
      await hooks.resolveMaster(tx, "color", c as unknown as Record<string, unknown>, ctx.tenantId);
      await tx.insert(colors).values({
        id: c.id,
        tenantId: ctx.tenantId,
        fabricId: c.fabricId,
        name: c.name,
        code: c.code ?? null,
        hex: c.hex ?? null,
        imageUrl: c.imageUrl ?? null,
      }).onConflictDoNothing({ target: colors.id });
    }

    for (const r of deps.rolls ?? []) {
      const [existing] = await tx
        .select({ id: rolls.id })
        .from(rolls)
        .where(and(eq(rolls.id, r.id), eq(rolls.tenantId, ctx.tenantId)))
        .limit(1);
      if (existing) continue;
      if (await hooks.tombstoneBlocks(ctx.tenantId, "roll", r.id)) continue;
      await hooks.resolveMaster(tx, "roll", r as unknown as Record<string, unknown>, ctx.tenantId);
      const inserted = await tx.insert(rolls).values({
        id: r.id,
        tenantId: ctx.tenantId,
        colorId: r.colorId,
        rollNo: r.rollNo,
        dyeBatch: r.dyeBatch ?? null,
        initialKg: String(r.initialKg),
        remainingKg: String(r.remainingKg),
        pieces: r.pieces,
        remainingPieces: r.remainingPieces,
        pricePerKg: String(r.pricePerKg),
        salePricePerKg: r.salePricePerKg != null ? String(r.salePricePerKg) : null,
        currency: r.currency || "SYP",
        // Same entry price as on the origin device; older snapshots carry none → the roll's own price.
        entryPricePerKg: String(r.entryPricePerKg ?? r.pricePerKg),
        entryCurrency: r.entryCurrency ?? (r.currency || "SYP"),
        entrySource: r.entrySource ?? "stock_in",
        entryReference: r.entryReference ?? null,
        supplierId: r.supplierId ?? null,
        entryDate: r.entryDate,
        widthCm: r.widthCm != null ? String(r.widthCm) : null,
        weightGsm: r.weightGsm != null ? String(r.weightGsm) : null,
        status: r.status || "in_stock",
        version: 1,
      }).onConflictDoNothing({ target: rolls.id }).returning({ id: rolls.id });
      // The origin device wrote the roll and its 'initial' stock movement together
      // (RollRepository.create); a replayed roll gets the same movement, so every node's
      // stock card starts the same way. Only when THIS call inserted it (a parallel lane may have).
      if (inserted.length > 0) {
        await recordStockMovement(
          tx,
          {
            rollId: r.id,
            direction: "in",
            movementType: "initial",
            quantityKg: Number(r.remainingKg),
            balanceAfterKg: Number(r.remainingKg),
            movementDate: r.entryDate,
            description: `إنشاء صبغة ${r.rollNo}`,
          },
          ctx,
        );
      }
    }
  },
};
