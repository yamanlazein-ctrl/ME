import { eq, and, ilike, or, sql, inArray, gte, lte } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IInvoiceRepository,
  InvoiceFilter,
} from "../../application/ports/IInvoiceRepository.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { orders } from "../orm/schemas/order.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import { notifyOrderAvailability } from "./orderAvailabilityNotifier.js";
import type { InvoiceData, CreateInvoiceInput } from "../../domain/entities/Invoice.js";
import { Invoice } from "../../domain/entities/Invoice.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresInvoiceRepository implements IInvoiceRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<InvoiceData | null> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    const lines = await this.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
    return this.toDomain(rows[0], lines);
  }

  async findByNumber(
    number: string,
    type: string,
    ctx: TenantContext,
  ): Promise<InvoiceData | null> {
    const rows = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.number, number),
          eq(invoices.type, type),
          eq(invoices.tenantId, ctx.tenantId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    const lines = await this.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, rows[0].id));
    return this.toDomain(rows[0], lines);
  }

  async list(filter: InvoiceFilter, ctx: TenantContext): Promise<PaginatedResult<InvoiceData>> {
    const conditions = [eq(invoices.tenantId, ctx.tenantId)];
    if (filter.partyId) conditions.push(eq(invoices.partyId, filter.partyId));
    if (filter.type) conditions.push(eq(invoices.type, filter.type));
    if (filter.status) conditions.push(eq(invoices.status, filter.status));
    // Problem 2 fix: apply the date range (fromDate/toDate) inclusively. The
    // filter fields were accepted by the schema but previously ignored here,
    // so date-range reports silently returned invoices outside the range.
    if (filter.fromDate) conditions.push(gte(invoices.date, filter.fromDate));
    if (filter.toDate) conditions.push(lte(invoices.date, filter.toDate));
    if (filter.search) {
      conditions.push(or(ilike(invoices.number!, `%${filter.search}%`))!);
    }
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(invoices)
        .where(where)
        .limit(limit)
        .offset(offset)
        // Problem 2 fix: order by invoice date (chronological), not createdAt,
        // so date-range exports list invoices in their real business order.
        .orderBy(invoices.date, invoices.createdAt),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(invoices)
        .where(where),
    ]);

    const ids = dataRows.map((r) => r.id);
    const items =
      ids.length > 0
        ? await this.db
            .select()
            .from(invoiceLines)
            .where(inArray(invoiceLines.invoiceId, ids))
        : [];
    const byId = new Map<string, typeof items>();
    for (const it of items) {
      const l = byId.get(it.invoiceId) ?? [];
      l.push(it);
      byId.set(it.invoiceId, l);
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
    input: CreateInvoiceInput,
    autoNumber: string,
    ctx: TenantContext,
  ): Promise<InvoiceData> {
    const entity = Invoice.create(input, autoNumber);
    const inv = entity.toData();

    const isSale = input.type === "sale";

    return this.db.transaction(async (tx) => {
      // Stock validation and deduction only for sale invoices.
      // Entry invoices add stock via roll creation — no deduction needed.
      const expectedVersions = new Map<string, number>();
      // C4+COGS: cost of goods sold for sale invoices = Σ(quantityKg × roll.pricePerKg),
      // captured at sale time so it is journaled (not just derived at read time).
      let cogsTotal = 0;
      if (isSale) {
        // BUG-17: a roll reserved by an open order must not be sold by a
        // different invoice. The only legitimate buyer of a `reserved` roll is
        // the order that pinned it — i.e. this invoice carries that orderId.
        let reservationOwners: Set<string> | null = null;
        if (input.orderId) {
          const ownerRows = await tx
            .select({ rollId: orderItems.rollId })
            .from(orderItems)
            .innerJoin(
              orders,
              and(
                eq(orderItems.orderId, orders.id),
                eq(orders.tenantId, ctx.tenantId),
                inArray(orders.status, ["open", "available", "partially_available"]),
              ),
            )
            .where(
              and(
                eq(orderItems.orderId, input.orderId as string),
                eq(orderItems.tenantId, ctx.tenantId),
              ),
            );
          reservationOwners = new Set(
            ownerRows.map((r) => r.rollId).filter((r): r is string => Boolean(r)),
          );
        }
        for (const line of input.lines) {
          const [r] = await tx
            .select({
              kg: rolls.remainingKg,
              version: rolls.version,
              status: rolls.status,
              pricePerKg: rolls.pricePerKg,
              colorId: rolls.colorId,
            })
            .from(rolls)
            .where(and(eq(rolls.id, line.rollId), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          if (!r || Number(r.kg) < line.quantityKg) {
            throw new Error(
              `Roll ${line.rollId} has insufficient stock (${Number(r?.kg ?? 0)}kg < ${line.quantityKg}kg)`,
            );
          }
          // Fix BUG-04 / H-2 (forensic audit 2026-08-15, live-reproduced): the
          // roll was locked and validated for stock/status only — the
          // client-supplied line.colorId/fabricId were stored verbatim with
          // no check against the roll's real color. PostgresOrderRepository
          // already enforces this exact invariant for reservations
          // (`if (it.colorId && rollRow.colorId !== it.colorId) throw`); this
          // is the same check, applied where the audit found it missing.
          if (line.colorId !== r.colorId) {
            throw new Error(
              `اللون المحدد للبند لا يطابق لون اللفافة ${line.rollId} الفعلي`,
            );
          }
          const [rollColor] = await tx
            .select({ fabricId: colors.fabricId })
            .from(colors)
            .where(and(eq(colors.id, r.colorId), eq(colors.tenantId, ctx.tenantId)))
            .limit(1);
          if (!rollColor || line.fabricId !== rollColor.fabricId) {
            throw new Error(
              `القماش المحدد للبند لا يطابق قماش لون اللفافة ${line.rollId} الفعلي`,
            );
          }
          if (r.status === "reserved" && !(reservationOwners?.has(line.rollId) ?? false)) {
            throw new Error(
              `اللفافة ${line.rollId} محجوزة لطلب آخر ولا يمكن بيعها في هذه الفاتورة`,
            );
          }
          if (r.status === "exhausted") {
            throw new Error(`اللفافة ${line.rollId} نفدت ولا يمكن بيعها`);
          }
          expectedVersions.set(line.rollId, Number(r.version));
          // Round quantity to the DB's scale (2dp) so the journaled COGS matches
          // the stored invoice line exactly (a 0.001kg input is stored as 0.00).
          const storedQty = Math.round(Number(line.quantityKg) * 100) / 100;
          cogsTotal += Math.round(storedQty * Number(r.pricePerKg));
        }
      }

      const [row] = await tx
        .insert(invoices)
        .values({
          tenantId: ctx.tenantId,
          number: autoNumber,
          type: input.type,
          date: input.date,
          partyId: input.partyId,
          partyType: input.partyType,
          currency: input.currency ?? "SYP",
          subtotal: inv.subtotal,
          discount: inv.discount,
          tax: inv.tax,
          shipping: input.shipping ?? 0,
          total: inv.total,
          notes: input.notes,
          createdBy: ctx.userId,
        })
        .returning();

      await tx.insert(invoiceLines).values(
        input.lines.map((l) => ({
          tenantId: ctx.tenantId,
          invoiceId: row.id,
          fabricId: l.fabricId,
          colorId: l.colorId,
          rollId: l.rollId,
          quantityKg: String(l.quantityKg),
          pieces: l.pieces ?? 1,
          pricePerKg: String(l.pricePerKg),
          discountAmount: l.discountAmount ?? 0,
          note: l.note,
        })),
      );

      // Deduct stock — sale invoices only, with optimistic locking
      if (isSale) {
        for (const line of input.lines) {
          const [r] = await tx
            .select({ remainingKg: rolls.remainingKg })
            .from(rolls)
            .where(and(eq(rolls.id, line.rollId), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          const newKg = Math.max(0, Number(r!.remainingKg) - line.quantityKg);
          const expectedVersion = expectedVersions.get(line.rollId);
          const updated = await tx
            .update(rolls)
            .set({
              remainingKg: String(newKg),
              status: sql`CASE WHEN ${String(newKg)} <= '0' THEN 'exhausted' ELSE ${rolls.status} END`,
              version: sql`${rolls.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(rolls.id, line.rollId),
                eq(rolls.tenantId, ctx.tenantId),
                eq(rolls.version, expectedVersion ?? 0),
              ),
            )
            .returning({ id: rolls.id });
          if (updated.length === 0) {
            throw new Error(
              `Roll ${line.rollId} was modified concurrently. Please retry.`,
            );
          }
          await recordStockMovement(
            tx,
            {
              rollId: line.rollId,
              direction: "out",
              movementType: "invoice_sale",
              quantityKg: line.quantityKg,
              balanceAfterKg: newKg,
              referenceType: "sales_invoice",
              referenceId: row.id,
              referenceNumber: autoNumber,
              movementDate: input.date,
              description: `Sale invoice ${autoNumber}`,
            },
            ctx,
          );
        }
      }

      // Entry invoices ADD stock to the referenced rolls. The frontend creates
      // each roll with remainingKg = 0 so this increment brings stock to the
      // real quantity. direct API callers referencing existing rolls see stock
      // increase by the invoice quantity (this is the documented behavior).
      if (!isSale) {
        for (const line of input.lines) {
          const [before] = await tx
            .select({ remainingKg: rolls.remainingKg, colorId: rolls.colorId })
            .from(rolls)
            .where(
              and(eq(rolls.id, line.rollId), eq(rolls.tenantId, ctx.tenantId)),
            )
            .for("update")
            .limit(1);
          // Fix BUG-04 / H-2: the entry-invoice increment path had NO
          // existence check at all — a nonexistent rollId silently defaulted
          // to `remainingKg ?? 0`, so the subsequent UPDATE matched zero rows
          // while recordStockMovement below still wrote a movement claiming
          // success. It also never checked line.colorId/fabricId against the
          // roll's real color, same gap as the sale path above.
          if (!before) {
            throw new Error(`اللفافة ${line.rollId} غير موجودة`);
          }
          if (line.colorId !== before.colorId) {
            throw new Error(
              `اللون المحدد للبند لا يطابق لون اللفافة ${line.rollId} الفعلي`,
            );
          }
          const [rollColor] = await tx
            .select({ fabricId: colors.fabricId })
            .from(colors)
            .where(and(eq(colors.id, before.colorId), eq(colors.tenantId, ctx.tenantId)))
            .limit(1);
          if (!rollColor || line.fabricId !== rollColor.fabricId) {
            throw new Error(
              `القماش المحدد للبند لا يطابق قماش لون اللفافة ${line.rollId} الفعلي`,
            );
          }
          const newKg = Number(before?.remainingKg ?? 0) + line.quantityKg;
          await tx
            .update(rolls)
            .set({
              remainingKg: sql`${rolls.remainingKg} + ${line.quantityKg}`,
              status: sql`CASE WHEN ${rolls.remainingKg} + ${line.quantityKg} > 0 THEN 'in_stock' ELSE ${rolls.status} END`,
              version: sql`${rolls.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(eq(rolls.id, line.rollId), eq(rolls.tenantId, ctx.tenantId)),
            );
          await recordStockMovement(
            tx,
            {
              rollId: line.rollId,
              direction: "in",
              movementType: "invoice_entry",
              quantityKg: line.quantityKg,
              balanceAfterKg: newKg,
              referenceType: "purchase_invoice",
              referenceId: row.id,
              referenceNumber: autoNumber,
              movementDate: input.date,
              description: `Purchase invoice ${autoNumber}`,
            },
            ctx,
          );
        }
        // C2 — auto-link: promote matching open customer orders and notify.
        await notifyOrderAvailability(tx, ctx, input.lines.map((l) => l.colorId));
      }

      // Write ledger entry — C4 fix: double-entry. Each transaction writes a
      // balanced set (Σdebit = Σcredit). All legs share the same referenceType +
      // referenceId so existing cancel-by-reference reverses every leg together.
      // Only the party leg carries partyId (drives the party statement/balance);
      // non-party legs (revenue / COGS / inventory) carry partyId = null.
      const invoiceType = isSale ? "sales_invoice" : "purchase_invoice";
      const currency = input.currency ?? "SYP";
      const legs: (typeof ledgerEntries.$inferInsert)[] = [
        {
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          date: input.date,
          type: invoiceType,
          debit: inv.total,
          credit: 0,
          currency,
          cashImpact: "none",
          referenceType: invoiceType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isSale ? "Sale invoice" : "Purchase invoice"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
      ];
      if (isSale) {
        // Revenue leg — balances the AR debit.
        legs.push({
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "sales_revenue",
          debit: 0,
          credit: inv.total,
          currency,
          cashImpact: "none",
          referenceType: invoiceType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `Sales revenue ${autoNumber}`,
          createdBy: ctx.userId,
        });
        // COGS legs — Dr COGS Expense / Cr Inventory Asset, journaled so profit is
        // auditable from the ledger (not only a read-time dashboard formula).
        if (cogsTotal > 0) {
          legs.push({
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date,
            type: "cogs_expense",
            debit: cogsTotal,
            credit: 0,
            currency,
            cashImpact: "none",
            referenceType: invoiceType,
            referenceId: row.id,
            referenceNumber: autoNumber,
            description: `Cost of goods sold ${autoNumber}`,
            createdBy: ctx.userId,
          });
          legs.push({
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date,
            type: "inventory_asset",
            debit: 0,
            credit: cogsTotal,
            currency,
            cashImpact: "none",
            referenceType: invoiceType,
            referenceId: row.id,
            referenceNumber: autoNumber,
            description: `Inventory relief ${autoNumber}`,
            createdBy: ctx.userId,
          });
        }
      } else {
        // Purchase invoice — balance the party debit with an inventory credit.
        legs.push({
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "inventory_asset",
          debit: 0,
          credit: inv.total,
          currency,
          cashImpact: "none",
          referenceType: invoiceType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `Inventory received ${autoNumber}`,
          createdBy: ctx.userId,
        });
      }
      await tx.insert(ledgerEntries).values(legs);

      // Linked receipt voucher for cash/on-account payments at sale time.
      // A partial or full payment (paid > 0) creates a linked receipt voucher
      // (number RCP-<invoiceNo>) plus a receipt_in ledger entry, all atomically.
      const paid = input.paid ?? 0;
      if (isSale && paid > 0) {
        if (paid > inv.total) {
          throw new Error(`المبلغ المدفوع (${paid}) أكبر من إجمالي الفاتورة (${inv.total})`);
        }
        const method = input.paymentMethod ?? "cash";
        const receiptNumber = `RCP-${autoNumber}`;
        const [voucherRow] = await tx
          .insert(vouchers)
          .values({
            tenantId: ctx.tenantId,
            kind: "receipt",
            number: receiptNumber,
            date: input.date,
            partyId: input.partyId,
            partyKind: "customer",
            invoiceId: row.id,
            amount: paid,
            currency: input.currency ?? "SYP",
            method,
            notesPrint: `قبض مرتبط بالفاتورة ${autoNumber}`,
            createdBy: ctx.userId,
          })
          .returning();

        await tx.insert(ledgerEntries).values([
          {
            tenantId: ctx.tenantId,
            partyId: input.partyId,
            date: input.date,
            type: "receipt_in",
            debit: 0,
            credit: paid,
            currency: input.currency ?? "SYP",
            cashImpact: "none",
            referenceType: "receipt_in",
            referenceId: voucherRow.id,
            referenceNumber: receiptNumber,
            description: `Receipt ${receiptNumber}`,
            createdBy: ctx.userId,
          },
          {
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date,
            type: "cash",
            debit: paid,
            credit: 0,
            currency: input.currency ?? "SYP",
            cashImpact: method === "cash" ? "in" : "none",
            referenceType: "receipt_in",
            referenceId: voucherRow.id,
            referenceNumber: receiptNumber,
            description: `Cash received ${receiptNumber}`,
            createdBy: ctx.userId,
          },
        ]);
      }

      const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, row.id));
      return this.toDomain(row, lines);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<InvoiceData> {
    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.tenantId, ctx.tenantId)))
        .for("update")
        .limit(1);
      if (!inv) throw Object.assign(new Error("Invoice not found"), { code: "NOT_FOUND" as const });
      if (inv.status === "cancelled") throw Object.assign(new Error("Invoice already cancelled"), { code: "ALREADY_CANCELLED" as const });

      const ilines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));

      // Release stock for sale invoices (restore what was deducted).
      // Reverse entry invoices (subtract what was added at create time).
      if (inv.type === "sale") {
        for (const l of ilines) {
          const [r] = await tx
            .select({ remainingKg: rolls.remainingKg })
            .from(rolls)
            .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          if (r) {
            const newKg = Number(r.remainingKg) + Number(l.quantityKg);
            await tx
              .update(rolls)
              .set({
                remainingKg: String(newKg),
                status: "in_stock",
                version: sql`${rolls.version} + 1`,
                updatedAt: new Date(),
              })
              .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)));
            await recordStockMovement(
              tx,
              {
                rollId: l.rollId,
                direction: "in",
                movementType: "invoice_sale",
                quantityKg: Number(l.quantityKg),
                balanceAfterKg: newKg,
                referenceType: "sales_invoice_cancel",
                referenceId: inv.id,
                referenceNumber: inv.number,
                movementDate: inv.date,
                description: `Cancel sale invoice ${inv.number} (restore stock)`,
              },
              ctx,
            );
          }
        }
      } else {
        for (const l of ilines) {
          const [r] = await tx
            .select({ remainingKg: rolls.remainingKg })
            .from(rolls)
            .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          if (r) {
            const newKg = Math.max(0, Number(r.remainingKg) - Number(l.quantityKg));
            await tx
              .update(rolls)
              .set({
                remainingKg: String(newKg),
                status: newKg <= 0 ? "exhausted" : "in_stock",
                version: sql`${rolls.version} + 1`,
                updatedAt: new Date(),
              })
              .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)));
            await recordStockMovement(
              tx,
              {
                rollId: l.rollId,
                direction: "out",
                movementType: "invoice_entry",
                quantityKg: Number(l.quantityKg),
                balanceAfterKg: newKg,
                referenceType: "purchase_invoice_cancel",
                referenceId: inv.id,
                referenceNumber: inv.number,
                movementDate: inv.date,
                description: `Cancel purchase invoice ${inv.number} (reverse stock)`,
              },
              ctx,
            );
          }
        }
      }

      // Cancel linked receipt vouchers (from cash/on-account sales) and reverse
      // their receipt_in ledger rows atomically.
      const linkedVouchers = await tx
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.invoiceId, id),
            eq(vouchers.tenantId, ctx.tenantId),
            eq(vouchers.status, "active"),
          ),
        );
      if (linkedVouchers.length > 0) {
        await tx
          .update(vouchers)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy,
            updatedAt: new Date(),
            version: sql`${vouchers.version} + 1`,
          })
          .where(
            and(
              eq(vouchers.invoiceId, id),
              eq(vouchers.tenantId, ctx.tenantId),
              eq(vouchers.status, "active"),
            ),
          );
        await tx
          .update(ledgerEntries)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledBy,
          })
          .where(
            and(
              eq(ledgerEntries.tenantId, ctx.tenantId),
              eq(ledgerEntries.referenceType, "receipt_in"),
              inArray(
                ledgerEntries.referenceId,
                linkedVouchers.map((v) => v.id),
              ),
              eq(ledgerEntries.status, "active"),
            ),
          );
      }

      // Cancel the linked ledger entry atomically
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
            eq(ledgerEntries.status, "active"),
          ),
        );

      const [updated] = await tx
        .update(invoices)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy,
          updatedAt: new Date(),
          version: sql`${invoices.version} + 1`,
        })
        .where(and(eq(invoices.id, id), eq(invoices.tenantId, ctx.tenantId)))
        .returning();

      return this.toDomain(
        updated,
        ilines.map((l) => ({ ...l, invoiceId: id })),
      );
    });
  }

  private toDomain(
    row: typeof invoices.$inferSelect,
    linesRows: (typeof invoiceLines.$inferSelect)[],
  ): InvoiceData {
    return Invoice.reconstitute(this.mapRow(row, linesRows)).toData();
  }

  private mapRow(
    row: typeof invoices.$inferSelect,
    linesRows: (typeof invoiceLines.$inferSelect)[],
  ): InvoiceData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      number: row.number,
      type: row.type as InvoiceData["type"],
      date: row.date,
      partyId: row.partyId,
      partyType: row.partyType as InvoiceData["partyType"],
      currency: row.currency,
      subtotal: row.subtotal,
      discount: row.discount,
      tax: row.tax,
      shipping: row.shipping,
      total: row.total,
      notes: n(row.notes),
      status: row.status as InvoiceData["status"],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      updatedAt: row.updatedAt.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
      cancellationReferenceId: n(row.cancellationReferenceId),
      lines: linesRows.map((l) => ({
        id: l.id,
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: Number(l.quantityKg),
        pieces: Number(l.pieces ?? 1),
        pricePerKg: Number(l.pricePerKg),
        discountAmount: Number(l.discountAmount),
        note: n(l.note),
      })),
    };
  }
}
