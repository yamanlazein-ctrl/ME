import { eq, and, desc, ilike, sql, getTableColumns } from "drizzle-orm";
import { afterCursor, cursorColumns, decodeCursor, keysetOrder, nextCursorOf, type KeysetSpec } from "./keysetPage.js";
import { likeContains } from "../utils/likeEscape.js";
import type { DB } from "../orm/drizzle.js";
import type {
  IRollRepository,
  RollFilter,
  CreateRollData,
} from "../../application/ports/IRollRepository.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import { cleanupRollsForDeletion } from "./rollDeletionHelper.js";
import { notifyOrderAvailability } from "./orderAvailabilityNotifier.js";
import { Roll, type RollData } from "../../domain/entities/Roll.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { assertRollPriceEditAllowed } from "../../domain/invoices/rollCostFreeze.js";

import { localToday } from "../utils/localDate.js";
export class PostgresRollRepository implements IRollRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<RollData | null> {
    const rows = await this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async findByRollNo(rollNo: string, ctx: TenantContext): Promise<RollData | null> {
    const rows = await this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.rollNo, rollNo), eq(rolls.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: RollFilter, ctx: TenantContext): Promise<PaginatedResult<RollData>> {
    const conditions = [eq(rolls.tenantId, ctx.tenantId)];
    if (filter.colorId) conditions.push(eq(rolls.colorId, filter.colorId));
    if (filter.status) conditions.push(eq(rolls.status, filter.status));
    if (filter.search) conditions.push(ilike(rolls.rollNo!, likeContains(filter.search))!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;
    // Keyset mode for "load every row" callers: seek after the cursor instead
    // of OFFSET (constant cost per page, strict total order). keysetPage.ts.
    const keyset: KeysetSpec = { createdAt: rolls.createdAt, id: rolls.id };
    const cursor = true ? decodeCursor(filter.cursor) : null;
    const pageWhere = cursor ? and(where, afterCursor(keyset, cursor)) : where;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({ ...getTableColumns(rolls), ...cursorColumns(keyset) })
        .from(rolls)
        .where(pageWhere)
        .limit(limit)
        .offset(cursor ? 0 : offset)
        .orderBy(...keysetOrder(keyset)),
      // Cursor pages skip the COUNT: the caller stops on nextCursor and the
      // first (cursor-less) page already carried the real total.
      cursor
        ? Promise.resolve([{ count: -1 }])
        : this.db
            .select({ count: sql<number>`count(*)` })
            .from(rolls)
            .where(where),
    ]);

    const nextCursor = nextCursorOf(dataRows as unknown as Array<Record<string, unknown>>, limit);
    return {
      data: dataRows.map((r) => this.toDomain(r)),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        // Without a cursor the COUNT decides; a last page hands out no cursor.
        nextCursor: cursor || offset + limit < Number(countRows[0]?.count ?? 0) ? nextCursor : null,
        hasNext: cursor ? nextCursor !== null : offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(data: CreateRollData, ctx: TenantContext): Promise<RollData> {
    const row = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(rolls)
        .values({
          tenantId: ctx.tenantId,
          colorId: data.colorId,
          rollNo: data.rollNo,
          dyeBatch: data.dyeBatch,
          initialKg: String(data.initialKg),
          remainingKg: String(data.remainingKg ?? data.initialKg),
          pieces: data.pieces ?? 1,
          // Mirror remainingKg semantics: born with stock → pieces available;
          // entry-invoice flow (remainingKg=0) → invoice transaction increments.
          remainingPieces:
            Number(data.remainingKg ?? data.initialKg) > 0 ? (data.pieces ?? 1) : (data.remainingPieces ?? 0),
          pricePerKg: String(data.pricePerKg),
          salePricePerKg: data.salePricePerKg ? String(data.salePricePerKg) : null,
          currency: data.currency ?? "SYP",
          supplierId: data.supplierId ?? null,
          entryDate: data.entryDate,
          widthCm: data.widthCm != null ? String(data.widthCm) : null,
          weightGsm: data.weightGsm != null ? String(data.weightGsm) : null,
        })
        .returning();
      await recordStockMovement(
        tx,
        {
          rollId: r.id,
          direction: "in",
          movementType: "initial",
          quantityKg: data.remainingKg ?? data.initialKg,
          balanceAfterKg: data.remainingKg ?? data.initialKg,
          movementDate: data.entryDate,
          description: `إنشاء صبغة ${data.rollNo}`,
        },
        ctx,
      );
      // C2 — auto-link: promote matching open customer orders and notify.
      await notifyOrderAvailability(tx, ctx, [data.colorId]);
      return r;
    });
    return this.toDomain(row);
  }

  async update(id: string, data: Partial<CreateRollData>, ctx: TenantContext): Promise<RollData> {
    // Quantity is document-driven. Schema rejects remainingKg; refuse here too
    // so non-HTTP callers cannot bypass inventory integrity.
    if (data.remainingKg !== undefined) {
      throw new Error(
        "لا يمكن تعديل الكمية المتبقية مباشرة من بطاقة الصبغة — استخدم فاتورة/مرتجع/تعديل مخزون معتمد",
      );
    }

    const values: Record<string, unknown> = {
      updatedAt: new Date(),
      version: sql`${rolls.version} + 1`,
    };
    if (data.rollNo !== undefined) values.rollNo = data.rollNo;
    if (data.dyeBatch !== undefined) values.dyeBatch = data.dyeBatch ?? null;
    if (data.initialKg !== undefined) values.initialKg = String(data.initialKg);
    if (data.pricePerKg !== undefined) values.pricePerKg = String(data.pricePerKg);
    if (data.salePricePerKg !== undefined)
      values.salePricePerKg = data.salePricePerKg ? String(data.salePricePerKg) : null;
    if (data.currency !== undefined) values.currency = data.currency;
    if (data.supplierId !== undefined) values.supplierId = data.supplierId ?? null;
    if (data.entryDate !== undefined) values.entryDate = data.entryDate;
    if (data.widthCm !== undefined)
      values.widthCm = data.widthCm != null ? String(data.widthCm) : null;
    if (data.weightGsm !== undefined)
      values.weightGsm = data.weightGsm != null ? String(data.weightGsm) : null;

    // Fix BUG-05 (forensic audit 2026-08-15, live-reproduced): PUT
    // /api/inventory/rolls/:id let remainingKg be overwritten directly with
    // no stock_movements row at all — every other write path to
    // remainingKg (invoice sale/entry, returns, print send/receive) records
    // one via recordStockMovement(); this path silently skipped it, so a
    // manual roll edit that changes stock leaves zero trace in the
    // "append-only audit trail of every stock change" the stock_movements
    // table's own schema comment promises. When remainingKg is not part of
    // this update, behavior is unchanged. When it is, the update now runs
    // inside a transaction that locks the row, reads the true prior
    // balance, and writes a matching "adjustment" movement so the change
    // is traceable and reconcilable against remainingKg like every other
    // mutation.
    //
    // Fix H-5 (forensic audit 2026-08-15, live-reproduced): `version` was
    // incremented on every update but never COMPARED — a blind
    // last-writer-wins write with no real optimistic lock, despite the
    // column existing for exactly this purpose (decrement()/increment()
    // below already enforce it correctly). A roll edit issued concurrently
    // with a sale could overwrite the sale's just-deducted remainingKg
    // with the editor's stale figure, silently erasing the sale.
    // `expectedVersion` is optional (see IRollRepository.ts) so callers
    // that haven't adopted it yet keep the previous blind-write behavior
    // unchanged; when sent, both the remainingKg-less and remainingKg
    // branches below enforce it with a real compare-and-swap in the
    // UPDATE's WHERE clause.
    const applyVersionGuard = (conditions: ReturnType<typeof and>[]): ReturnType<typeof and>[] =>
      data.expectedVersion !== undefined
        ? [...conditions, eq(rolls.version, data.expectedVersion)]
        : conditions;

    if (data.remainingKg === undefined) {
      // F05 (Phase 1 foundation audit): pricePerKg is this roll's cost
      // basis — COGS is frozen from it at the moment of sale
      // (resolveSaleCostPerKg / saleCogsConversion.ts) and never revalued
      // afterward, exactly like an invoice's historical FX rate is frozen
      // and cannot be silently changed after posting (see the FX-freeze
      // comments in PostgresInvoiceRepository). Once any stock has already
      // left this roll, its price was already used to post real COGS/GL
      // entries; editing it further would make the live inventory report
      // (GET /inventory/rolls, priced at the CURRENT pricePerKg) diverge
      // from what the GL and already-issued invoices actually recorded —
      // the exact "inventory cost differs between invoice and report"
      // symptom. Mirrors the existing remainingKg guard above (BUG-05):
      // block the direct edit, point the user at the correct flow instead
      // of silently corrupting the audit trail.
      if (data.pricePerKg !== undefined) {
        return this.db.transaction(async (tx) => {
          const [current] = await tx
            .select({
              rollNo: rolls.rollNo,
              initialKg: rolls.initialKg,
              remainingKg: rolls.remainingKg,
              pricePerKg: rolls.pricePerKg,
            })
            .from(rolls)
            .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          if (!current) throw new Error("Roll not found");

          assertRollPriceEditAllowed({
            rollNo: current.rollNo,
            initialKg: Number(current.initialKg),
            remainingKg: Number(current.remainingKg),
            currentPricePerKg: Number(current.pricePerKg),
            newPricePerKg: Number(data.pricePerKg),
          });

          const [row] = await tx
            .update(rolls)
            .set(values)
            .where(and(...applyVersionGuard([eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)])))
            .returning();
          if (!row) {
            if (data.expectedVersion !== undefined) {
              throw new Error("تم تعديل اللفافة بواسطة عملية أخرى — أعد التحميل والمحاولة مرة أخرى");
            }
            throw new Error("Roll not found");
          }
          return this.toDomain(row);
        });
      }

      const [row] = await this.db
        .update(rolls)
        .set(values)
        .where(and(...applyVersionGuard([eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)])))
        .returning();
      if (!row) {
        if (data.expectedVersion !== undefined) {
          const stillExists = await this.findById(id, ctx);
          throw new Error(
            stillExists
              ? "تم تعديل اللفافة بواسطة عملية أخرى — أعد التحميل والمحاولة مرة أخرى"
              : "Roll not found",
          );
        }
        throw new Error("Roll not found");
      }
      return this.toDomain(row);
    }

    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ remainingKg: rolls.remainingKg })
        .from(rolls)
        .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
        .for("update")
        .limit(1);
      if (!before) throw new Error("Roll not found");

      const [row] = await tx
        .update(rolls)
        .set(values)
        .where(and(...applyVersionGuard([eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)])))
        .returning();
      if (!row) {
        if (data.expectedVersion !== undefined) {
          throw new Error("تم تعديل اللفافة بواسطة عملية أخرى — أعد التحميل والمحاولة مرة أخرى");
        }
        throw new Error("Roll not found");
      }

      const oldKg = Number(before.remainingKg);
      const newKg = Number(data.remainingKg);
      const delta = Math.round((newKg - oldKg) * 100) / 100;
      if (delta !== 0) {
        await recordStockMovement(
          tx,
          {
            rollId: id,
            direction: delta > 0 ? "in" : "out",
            movementType: "adjustment",
            quantityKg: Math.abs(delta),
            balanceAfterKg: newKg,
            movementDate: localToday(),
            description: `تعديل يدوي على اللفافة عبر شاشة المخزون (${oldKg} → ${newKg} كغ)`,
          },
          ctx,
        );
      }
      return this.toDomain(row);
    });
  }

  async decrement(
    id: string,
    kg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<RollData> {
    await this.getAndLock(id, ctx);
    const r = await this.findById(id, ctx);
    if (!r) throw new Error("Roll not found");
    Roll.reconstitute(r).decrement(kg);
    const [row] = await this.db
      .update(rolls)
      .set({
        remainingKg: String(r.remainingKg - kg),
        version: sql`${rolls.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId), eq(rolls.version, expectedVersion)),
      )
      .returning();
    if (!row) throw new Error("Concurrent modification on roll");
    return this.toDomain(row);
  }

  async increment(
    id: string,
    kg: number,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<RollData> {
    await this.getAndLock(id, ctx);
    const r = await this.findById(id, ctx);
    if (!r) throw new Error("Roll not found");
    Roll.reconstitute(r).increment(kg);
    const [row] = await this.db
      .update(rolls)
      .set({
        remainingKg: String(r.remainingKg + kg),
        version: sql`${rolls.version} + 1`,
        status: "in_stock",
        updatedAt: new Date(),
      })
      .where(
        and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId), eq(rolls.version, expectedVersion)),
      )
      .returning();
    if (!row) throw new Error("Concurrent modification on roll");
    return this.toDomain(row);
  }

  async delete(id: string, ctx: TenantContext): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await cleanupRollsForDeletion({ tx, ctx, rollIds: [id] });
      const deleted = await tx
        .delete(rolls)
        .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
        .returning({ id: rolls.id });
      return deleted.length > 0;
    });
  }

  private async getAndLock(id: string, ctx: TenantContext): Promise<void> {
    await this.db
      .select()
      .from(rolls)
      .where(and(eq(rolls.id, id), eq(rolls.tenantId, ctx.tenantId)))
      .for("update")
      .limit(1);
  }

  private toDomain(row: typeof rolls.$inferSelect): RollData {
    return Roll.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof rolls.$inferSelect): RollData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      colorId: row.colorId,
      rollNo: row.rollNo,
      dyeBatch: n(row.dyeBatch),
      initialKg: Number(row.initialKg),
      remainingKg: Number(row.remainingKg),
      pieces: Number(row.pieces ?? 1),
      remainingPieces: Number(row.remainingPieces ?? 0),
      pricePerKg: Number(row.pricePerKg),
      salePricePerKg: row.salePricePerKg ? Number(row.salePricePerKg) : undefined,
      currency: row.currency,
      supplierId: n(row.supplierId),
      entryDate: row.entryDate,
      widthCm: row.widthCm ? Number(row.widthCm) : undefined,
      weightGsm: row.weightGsm ? Number(row.weightGsm) : undefined,
      status: row.status as RollData["status"],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
