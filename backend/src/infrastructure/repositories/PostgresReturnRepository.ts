import { eq, and, desc, ilike, or, ne, sql, inArray, gte, lte } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IReturnRepository, ReturnFilter } from "../../application/ports/IReturnRepository.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import {
  ReturnDoc,
  type ReturnData,
  type CreateReturnInput,
} from "../../domain/entities/Return.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresReturnRepository implements IReturnRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<ReturnData | null> {
    const rows = await this.db
      .select()
      .from(returns)
      .where(and(eq(returns.id, id), eq(returns.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    const lines = await this.db.select().from(returnLines).where(eq(returnLines.returnId, id));
    return this.toDomain(rows[0], lines);
  }

  async list(filter: ReturnFilter, ctx: TenantContext): Promise<PaginatedResult<ReturnData>> {
    const conditions = [eq(returns.tenantId, ctx.tenantId)];
    if (filter.kind) conditions.push(eq(returns.kind, filter.kind));
    if (filter.partyId) conditions.push(eq(returns.partyId, filter.partyId));
    if (filter.status) conditions.push(eq(returns.status, filter.status));
    if (filter.fromDate) conditions.push(gte(returns.date, filter.fromDate));
    if (filter.toDate) conditions.push(lte(returns.date, filter.toDate));
    if (filter.search) conditions.push(or(ilike(returns.number!, `%${filter.search}%`))!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(returns)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(returns.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(returns)
        .where(where),
    ]);

    const ids = dataRows.map((r) => r.id);
    const items =
      ids.length > 0
        ? await this.db.select().from(returnLines).where(inArray(returnLines.returnId, ids))
        : [];
    const byId = new Map<string, typeof items>();
    for (const it of items) {
      const l = byId.get(it.returnId) ?? [];
      l.push(it);
      byId.set(it.returnId, l);
    }

    return {
      data: dataRows.map((r) => this.toDomain(r, byId.get(r.id) ?? [])),
      meta: {
        total: Number(countRows[0]?.count ?? 0),
        page,
        limit,
        hasNext: offset + limit < Number(countRows[0]?.count ?? 0),
        totalPages: Math.ceil(Number(countRows[0]?.count ?? 0) / limit),
      },
    };
  }

  async create(
    input: CreateReturnInput,
    autoNumber: string,
    ctx: TenantContext,
  ): Promise<ReturnData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(returns)
        .values({
          tenantId: ctx.tenantId,
          number: autoNumber,
          kind: input.kind,
          date: input.date,
          partyId: input.partyId,
          originalInvoiceId: input.originalInvoiceId ?? null,
          reason: input.reason,
          currency: input.currency ?? "SYP",
          notesPrint: input.notesPrint,
          notesInternal: input.notesInternal,
          createdBy: ctx.userId,
        })
        .returning();

      // Return lines are inserted after validation with server-derived price (fix 3.2c)
      // and aggregated by rollId (fix 3.2b). Insert is deferred until after guard.

      // Validate return quantities against real historical movement — never
      // allow a return to exceed what was actually sold/purchased on that
      // exact roll for that exact party, regardless of whether a specific
      // originalInvoiceId is given.
      //
      // Fix BUG-01 / H-1 (forensic audit 2026-08-15, live-reproduced against
      // a real Postgres instance before this fix): the previous version only
      // ran this guard `if (input.originalInvoiceId)`, and even then only
      // checked lines whose rollId existed in the map — a line for a roll
      // NOT on that invoice was silently skipped (`if (entry && ...)`), and
      // a return with no originalInvoiceId at all (the UI's own default —
      // ReturnForm.tsx ships a "— بدون فاتورة —" option) skipped this block
      // entirely. Both paths let a sale return with `Math.max(0, currentKg
      // + quantityKg)` (no upper bound at all for sale-kind) fabricate
      // unlimited stock with no invoice link whatsoever. Live repro:
      // a fresh 50kg roll became 550kg from a single unlinked sale return,
      // and a real invoice's return became 200kg heavier on a roll that
      // invoice never sold, recorded straight into stock_movements as if
      // legitimate.
      //
      // The fix keeps the "originalInvoiceId is optional" UX (a business
      // may legitimately not track which specific invoice a return maps
      // to), but conservation is never optional: the eligible quantity is
      // always derived from real invoice_lines history for that
      // roll+party, either scoped to one invoice (when given, and then
      // every line's roll MUST belong to it — no more silent skip) or
      // across the party's whole active invoice history for that roll
      // (when not given).
      // Unified eligibility: keyed on (rollId, partyId, kind) across all active
      // returns, regardless of originalInvoiceId linkage. Takes min(invoice-scoped,
      // party-scoped) remaining so unlinked returns are never invisible to a
      // later linked return (fix 3.2a). Aggregates input by rollId (fix 3.2b) and
      // sums invoice duplicates via GROUP BY (fixes .set() overwrite).
      const invoiceLineQtys = new Map<
        string,
        { original: number; returned: number; pricePerKg: number; currency: string }
      >();
      const expectedInvoiceType = input.kind === "sale" ? "sale" : "entry";

      // Currency mismatch check will run after we load the invoice(s)
      const inputCurrency = input.currency ?? "SYP";
      let invoiceCurrency: string | null = null;

      if (input.originalInvoiceId) {
        const [origInv] = await tx
          .select({
            type: invoices.type,
            partyId: invoices.partyId,
            status: invoices.status,
            currency: invoices.currency,
          })
          .from(invoices)
          .where(and(eq(invoices.id, input.originalInvoiceId), eq(invoices.tenantId, ctx.tenantId)))
          .limit(1);
        if (!origInv) throw new Error("الفاتورة الأصلية غير موجودة");
        if (origInv.type !== expectedInvoiceType)
          throw new Error(`نوع الفاتورة الأصلية (${origInv.type}) لا يطابق نوع المرتجع (${input.kind})`);
        if (origInv.status !== "active") throw new Error("لا يمكن الإرجاع على فاتورة ملغاة");
        if (origInv.partyId !== input.partyId) throw new Error("الفاتورة الأصلية لا تخص هذا الطرف");
        invoiceCurrency = origInv.currency;
        if (invoiceCurrency !== inputCurrency)
          throw new Error(`عملة المرتجع (${inputCurrency}) لا تطابق عملة الفاتورة الأصلية (${invoiceCurrency})`);
        // Aggregate invoice lines by rollId (SUM) and capture price/currency per roll
        const origLines = await tx
          .select({
            rollId: invoiceLines.rollId,
            qty: sql<number>`COALESCE(SUM(${invoiceLines.quantityKg}),0)`,
            price: sql<number>`AVG(${invoiceLines.pricePerKg})`,
          })
          .from(invoiceLines)
          .where(and(eq(invoiceLines.invoiceId, input.originalInvoiceId), eq(invoiceLines.tenantId, ctx.tenantId)))
          .groupBy(invoiceLines.rollId);
        for (const ol of origLines) {
          invoiceLineQtys.set(ol.rollId, {
            original: Math.round(Number(ol.qty) * 100) / 100,
            returned: 0,
            pricePerKg: Math.round(Number(ol.price) * 100) / 100,
            currency: invoiceCurrency,
          });
        }
        // All active returns for same party+kind+roll, regardless of linkage
        const rollIds = Array.from(new Set(input.lines.map((l) => l.rollId)));
        const prevReturns = await tx
          .select({ rollId: returnLines.rollId, total: sql<number>`COALESCE(SUM(${returnLines.quantityKg}),0)` })
          .from(returnLines)
          .innerJoin(
            returns,
            and(
              eq(returns.id, returnLines.returnId),
              ne(returns.id, row.id),
              eq(returns.status, "active"),
              eq(returns.kind, input.kind),
              eq(returns.partyId, input.partyId),
              eq(returns.tenantId, ctx.tenantId),
            ),
          )
          .where(inArray(returnLines.rollId, rollIds))
          .groupBy(returnLines.rollId);
        for (const pr of prevReturns) {
          const entry = invoiceLineQtys.get(pr.rollId);
          if (entry) entry.returned = Math.round(Number(pr.total) * 100) / 100;
        }
      } else {
        const rollIds = Array.from(new Set(input.lines.map((l) => l.rollId)));
        const historical = await tx
          .select({
            rollId: invoiceLines.rollId,
            total: sql<number>`COALESCE(SUM(${invoiceLines.quantityKg}),0)`,
            price: sql<number>`AVG(${invoiceLines.pricePerKg})`,
            currency: sql<string>`MAX(${invoices.currency})`,
          })
          .from(invoiceLines)
          .innerJoin(
            invoices,
            and(
              eq(invoices.id, invoiceLines.invoiceId),
              eq(invoices.tenantId, ctx.tenantId),
              eq(invoices.partyId, input.partyId),
              eq(invoices.type, expectedInvoiceType),
              eq(invoices.status, "active"),
            ),
          )
          .where(and(eq(invoiceLines.tenantId, ctx.tenantId), inArray(invoiceLines.rollId, rollIds)))
          .groupBy(invoiceLines.rollId);
        for (const h of historical) {
          if (String(h.currency) !== inputCurrency)
            throw new Error(`عملة المرتجع (${inputCurrency}) لا تطابق عملة الفواتير الأصلية (${h.currency})`);
          invoiceLineQtys.set(h.rollId, {
            original: Math.round(Number(h.total) * 100) / 100,
            returned: 0,
            pricePerKg: Math.round(Number(h.price) * 100) / 100,
            currency: String(h.currency),
          });
        }
        const prevReturns = await tx
          .select({ rollId: returnLines.rollId, total: sql<number>`COALESCE(SUM(${returnLines.quantityKg}),0)` })
          .from(returnLines)
          .innerJoin(
            returns,
            and(
              eq(returns.id, returnLines.returnId),
              ne(returns.id, row.id),
              eq(returns.status, "active"),
              eq(returns.kind, input.kind),
              eq(returns.partyId, input.partyId),
              eq(returns.tenantId, ctx.tenantId),
            ),
          )
          .where(inArray(returnLines.rollId, rollIds))
          .groupBy(returnLines.rollId);
        for (const pr of prevReturns) {
          const entry = invoiceLineQtys.get(pr.rollId);
          if (entry) entry.returned = Math.round(Number(pr.total) * 100) / 100;
        }
      }

      // Aggregate input lines by rollId before guard (fix 3.2b duplicate lines)
      const inputByRoll = new Map<string, number>();
      for (const line of input.lines) {
        inputByRoll.set(line.rollId, (inputByRoll.get(line.rollId) ?? 0) + line.quantityKg);
      }
      for (const [rollId, totalQty] of inputByRoll) {
        const entry = invoiceLineQtys.get(rollId);
        const verb = input.kind === "sale" ? "بيعها" : "شراؤها";
        if (!entry) {
          throw new Error(
            input.originalInvoiceId
              ? `اللفافة المحددة لا تنتمي إلى بنود الفاتورة الأصلية المحددة`
              : `لا يوجد سجل بأن هذه اللفافة تم ${verb} لهذا الطرف — لا يمكن إرجاعها`,
          );
        }
        if (totalQty > entry.original - entry.returned) {
          const verb2 = input.kind === "sale" ? "المباعة" : "المشتراة";
          throw new Error(
            `الكمية المرتجعة (${totalQty} كغ) تتجاوز الكمية ${verb2} (${entry.original} كغ) بعد خصم المرتجعات السابقة (${entry.returned} كغ)`,
          );
        }
      }

      // Insert aggregated return lines with server-derived price (fix 3.2b+3.2c)
      // One row per rollId, price from invoice_lines, not client.
      const piecesByRoll = new Map<string, number>();
      for (const l of input.lines) piecesByRoll.set(l.rollId, (piecesByRoll.get(l.rollId) ?? 0) + (l.pieces ?? 1));
      await tx.insert(returnLines).values(
        Array.from(inputByRoll.entries()).map(([rollId, totalQty]) => {
          const entry = invoiceLineQtys.get(rollId)!;
          return {
            tenantId: ctx.tenantId,
            returnId: row.id,
            rollId,
            quantityKg: String(totalQty),
            pieces: piecesByRoll.get(rollId) ?? 1,
            pricePerKg: String(entry.pricePerKg),
          };
        }),
      );

      for (const [rollId, totalQty] of inputByRoll) {
        const [r] = await tx
          .select({ remainingKg: rolls.remainingKg, version: rolls.version })
          .from(rolls)
          .where(and(eq(rolls.id, rollId), eq(rolls.tenantId, ctx.tenantId)))
          .for("update")
          .limit(1);
        if (r) {
          const currentKg = Number(r.remainingKg);
          // مرتجع إدخال = إرجاع مواد للمورد → ينقص المخزون؛ مرتجع بيع = استرجاع من العميل → يزيد المخزون
          const delta = input.kind === "entry" ? -totalQty : totalQty;
          const newKg = Math.max(0, currentKg + delta);
          if (input.kind === "entry" && currentKg < totalQty) {
            throw new Error(`الكمية المرتجعة (${totalQty} كغ) تتجاوز المتاح في الصبغة (${currentKg} كغ)`);
          }
          const updated = await tx
            .update(rolls)
            .set({
              remainingKg: String(newKg),
              status: sql`CASE WHEN ${String(newKg)} <= '0' THEN 'exhausted' ELSE 'in_stock' END`,
              version: sql`${rolls.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(rolls.id, rollId),
                eq(rolls.tenantId, ctx.tenantId),
                eq(rolls.version, Number(r.version)),
              ),
            )
            .returning({ id: rolls.id });
          if (updated.length === 0) {
            throw new Error(`Roll ${rollId} was modified concurrently. Please retry.`);
          }
          await recordStockMovement(
            tx,
            {
              rollId,
              direction: input.kind === "entry" ? "out" : "in",
              movementType: input.kind === "entry" ? "return_entry" : "return_sale",
              quantityKg: totalQty,
              balanceAfterKg: newKg,
              referenceType: input.kind === "entry" ? "purchase_return" : "sales_return",
              referenceId: row.id,
              referenceNumber: autoNumber,
              movementDate: input.date,
              description: `${input.kind === "entry" ? "Entry return" : "Sale return"} ${autoNumber}`,
            },
            ctx,
          );
        }
      }

      // Write the ledger entry for the return (atomic with stock + return).
      // Returns always CREDIT the party account, reversing the invoice debit.
      // Price is server-derived from invoice_lines (fix 3.2c), never client-supplied.
      const isEntryReturn = input.kind === "entry";
      let returnTotal = 0;
      for (const [rollId, totalQty] of inputByRoll) {
        const entry = invoiceLineQtys.get(rollId)!;
        returnTotal += Math.round(totalQty * entry.pricePerKg);
      }
      const returnRefType = isEntryReturn ? "purchase_return" : "sales_return";
      if (returnTotal > 0) {
        // C4 fix: double-entry. Party leg (credits the party) + balancing
        // inventory leg (debit) so the transaction nets to zero.
        await tx.insert(ledgerEntries).values([
          {
            tenantId: ctx.tenantId,
            partyId: input.partyId,
            date: input.date,
            type: returnRefType,
            debit: 0,
            credit: returnTotal,
            currency: input.currency ?? "SYP",
            cashImpact: "none",
            referenceType: returnRefType,
            referenceId: row.id,
            referenceNumber: autoNumber,
            description: `${isEntryReturn ? "Entry return" : "Sale return"} ${autoNumber}`,
            createdBy: ctx.userId,
          },
          {
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date,
            type: "inventory_asset",
            debit: returnTotal,
            credit: 0,
            currency: input.currency ?? "SYP",
            cashImpact: "none",
            referenceType: returnRefType,
            referenceId: row.id,
            referenceNumber: autoNumber,
            description: `Inventory ${isEntryReturn ? "relief" : "reinstated"} ${autoNumber}`,
            createdBy: ctx.userId,
          },
        ]);
      }

      const lines = await tx.select().from(returnLines).where(eq(returnLines.returnId, row.id));
      return this.toDomain(row, lines);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<ReturnData> {
    return this.db.transaction(async (tx) => {
      const [r] = await tx
        .select()
        .from(returns)
        .where(
          and(eq(returns.id, id), eq(returns.tenantId, ctx.tenantId), eq(returns.status, "active")),
        )
        .for("update")
        .limit(1);
      if (!r) throw new Error("Return not found or already cancelled");

      const lines = await tx.select().from(returnLines).where(eq(returnLines.returnId, id));

      for (const l of lines) {
        const [roll] = await tx
          .select({ remainingKg: rolls.remainingKg, version: rolls.version })
          .from(rolls)
          .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)))
          .for("update")
          .limit(1);
        if (roll) {
          // عكس التأثير الأصلي عند الإلغاء: مرتجع إدخال → يعيد الكمية للمخزون؛ مرتجع بيع → يخصمها
          const delta = r.kind === "entry" ? Number(l.quantityKg) : -Number(l.quantityKg);
          const newKg = Math.max(0, Number(roll.remainingKg) + delta);
          const updated = await tx
            .update(rolls)
            .set({
              remainingKg: String(newKg),
              status: sql`CASE WHEN ${String(newKg)} <= '0' THEN 'exhausted' ELSE 'in_stock' END`,
              version: sql`${rolls.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(rolls.id, l.rollId),
                eq(rolls.tenantId, ctx.tenantId),
                eq(rolls.version, Number(roll.version)),
              ),
            )
            .returning({ id: rolls.id });
          if (updated.length === 0) {
            throw new Error(`Roll ${l.rollId} was modified concurrently. Please retry.`);
          }
          await recordStockMovement(
            tx,
            {
              rollId: l.rollId,
              direction: r.kind === "entry" ? "in" : "out",
              movementType: r.kind === "entry" ? "return_entry" : "return_sale",
              quantityKg: Number(l.quantityKg),
              balanceAfterKg: newKg,
              referenceType: r.kind === "entry" ? "purchase_return_cancel" : "sales_return_cancel",
              referenceId: r.id,
              referenceNumber: r.number,
              movementDate: r.date,
              description: `Cancel ${r.kind === "entry" ? "entry" : "sale"} return ${r.number} (reverse stock)`,
            },
            ctx,
          );
        }
      }

      // Reverse the linked ledger entry atomically when the return is cancelled
      // (mirrors PostgresInvoiceRepository.cancel / PostgresVoucherRepository.cancel).
      await tx
        .update(ledgerEntries)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
        })
        .where(
          and(
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            or(
              eq(ledgerEntries.referenceType, "purchase_return"),
              eq(ledgerEntries.referenceType, "sales_return"),
            ),
            eq(ledgerEntries.status, "active"),
          ),
        );

      const [updated] = await tx
        .update(returns)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
          version: sql`${returns.version} + 1`,
        })
        .where(and(eq(returns.id, id), eq(returns.tenantId, ctx.tenantId)))
        .returning();

      return this.toDomain(updated, lines);
    });
  }

  private toDomain(
    row: typeof returns.$inferSelect,
    linesRows: (typeof returnLines.$inferSelect)[],
  ): ReturnData {
    return ReturnDoc.reconstitute(this.mapRow(row, linesRows)).toData();
  }

  private mapRow(
    row: typeof returns.$inferSelect,
    linesRows: (typeof returnLines.$inferSelect)[],
  ): ReturnData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      number: row.number,
      kind: row.kind as ReturnData["kind"],
      date: row.date,
      partyId: row.partyId,
      originalInvoiceId: n(row.originalInvoiceId),
      reason: row.reason,
      currency: row.currency,
      notesPrint: n(row.notesPrint),
      notesInternal: n(row.notesInternal),
      status: row.status as ReturnData["status"],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
      lines: linesRows.map((l) => ({
        id: l.id,
        returnId: l.returnId,
        rollId: l.rollId,
        quantityKg: Number(l.quantityKg),
        pieces: l.pieces ?? 1,
        pricePerKg: Number(l.pricePerKg),
      })),
    };
  }
}
