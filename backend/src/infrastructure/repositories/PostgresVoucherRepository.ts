import { eq, and, desc, ilike, or, sql, gte, lte } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IVoucherRepository,
  VoucherFilter,
} from "../../application/ports/IVoucherRepository.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { returnLines } from "../orm/schemas/return-line.table.js";
import {
  Voucher,
  type VoucherData,
  type CreateVoucherInput,
} from "../../domain/entities/Voucher.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";

export class PostgresVoucherRepository implements IVoucherRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<VoucherData | null> {
    const rows = await this.db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, id), eq(vouchers.tenantId, ctx.tenantId)))
      .limit(1);
    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: VoucherFilter, ctx: TenantContext): Promise<PaginatedResult<VoucherData>> {
    const conditions = [eq(vouchers.tenantId, ctx.tenantId)];
    if (filter.kind) conditions.push(eq(vouchers.kind, filter.kind));
    if (filter.partyId) conditions.push(eq(vouchers.partyId, filter.partyId));
    if (filter.invoiceId) conditions.push(eq(vouchers.invoiceId, filter.invoiceId));
    if (filter.status) conditions.push(eq(vouchers.status, filter.status));
    if (filter.fromDate) conditions.push(gte(vouchers.date, filter.fromDate));
    if (filter.toDate) conditions.push(lte(vouchers.date, filter.toDate));
    if (filter.search) conditions.push(or(ilike(vouchers.number!, `%${filter.search}%`))!);
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(vouchers)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(vouchers.createdAt)),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(vouchers)
        .where(where),
    ]);

    return {
      data: dataRows.map((r) => this.toDomain(r)),
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
    input: CreateVoucherInput,
    autoNumber: string,
    ctx: TenantContext,
  ): Promise<VoucherData> {
    return this.db.transaction(async (tx) => {
      if (input.invoiceId) {
        // TX7 fix: lock the invoice row so concurrent voucher inserts serialize
        // and the remaining = total − active_vouchers − returns computation sees
        // committed values. Without this lock, two concurrent transactions read
        // the same voucher sum snapshot and both pass the guard, allowing
        // over-collection.
        const [inv] = await tx
          .select({
            total: invoices.total,
            status: invoices.status,
            currency: invoices.currency,
          })
          .from(invoices)
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, ctx.tenantId)))
          .for("update")
          .limit(1);
        if (!inv) throw new Error("الفاتورة المرتبطة غير موجودة");
        // TX5 fix: refuse vouchers against cancelled invoices so the user
        // can't collect on a cancelled document (silent data corruption).
        if (inv.status === "cancelled") {
          throw new Error("لا يمكن إنشاء سند لفاتورة مُلغاة");
        }
        // Cross-currency guard: refuse a voucher whose currency differs from the
        // linked invoice. Mixed-currency payments silently corrupt the party
        // balance (Bug E2E #7). No FX conversion is supported at this layer.
        const voucherCurrency = input.currency ?? "SYP";
        if (inv.currency !== voucherCurrency) {
          throw new Error(
            `لا يمكن سداد فاتورة بعملة مختلفة عن عملة السند (فاتورة: ${inv.currency}، سند: ${voucherCurrency})`,
          );
        }
        const existing = await tx
          .select({ paid: sql<number>`COALESCE(SUM(${vouchers.amount}), 0)` })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.invoiceId, input.invoiceId),
              eq(vouchers.tenantId, ctx.tenantId),
              eq(vouchers.status, "active"),
            ),
          );
        // Active returns against this invoice also reduce the amount owed by the
        // party (a sale return credits the customer, mirroring a receipt).
        const [retAgg] = await tx
          .select({
            total: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
          })
          .from(returnLines)
          .innerJoin(returns, eq(returnLines.returnId, returns.id))
          .where(
            and(
              eq(returns.originalInvoiceId, input.invoiceId),
              eq(returns.tenantId, ctx.tenantId),
              eq(returns.status, "active"),
            ),
          );
        const returnsAmount = Number(retAgg?.total ?? 0);
        const remaining = Number(inv.total) - Number(existing[0]?.paid ?? 0) - returnsAmount;
        if (input.amount > remaining) {
          throw new Error(`المبلغ يتجاوز المتبقي على الفاتورة (${remaining})`);
        }
      }

      const [row] = await tx
        .insert(vouchers)
        .values({
          tenantId: ctx.tenantId,
          kind: input.kind,
          number: autoNumber,
          date: input.date,
          partyId: input.partyId,
          partyKind: input.partyKind,
          invoiceId: input.invoiceId ?? null,
          amount: input.amount,
          currency: input.currency ?? "SYP",
          method: input.method,
          notesPrint: input.notesPrint,
          notesInternal: input.notesInternal,
          createdBy: ctx.userId,
        })
        .returning();

      // Write the ledger entry atomically with the voucher — mirrors
      // PostgresInvoiceRepository. Vouchers always CREDIT the party account:
      // a receipt credits the customer (customer paid), a payment credits the
      // supplier (we paid). Cash impact follows method — cashbox reads
      // cashImpact, not the debit/credit side.
      const isPayment = input.kind === "payment";
      const refType = isPayment ? "payment_out" : "receipt_in";
      const cashImpact = input.method === "cash" ? (isPayment ? "out" : "in") : "none";
      // C4 fix: double-entry. Party leg (credits the party, no cash impact) +
      // balancing cash leg (carries cashImpact so the cashbox still reads it).
      await tx.insert(ledgerEntries).values([
        {
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          date: input.date,
          type: refType,
          debit: 0,
          credit: input.amount,
          currency: input.currency ?? "SYP",
          cashImpact: "none",
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "Payment" : "Receipt"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
        {
          tenantId: ctx.tenantId,
          partyId: null,
          date: input.date,
          type: "cash",
          debit: input.amount,
          credit: 0,
          currency: input.currency ?? "SYP",
          cashImpact,
          referenceType: refType,
          referenceId: row.id,
          referenceNumber: autoNumber,
          description: `${isPayment ? "Cash paid" : "Cash received"} ${autoNumber}`,
          createdBy: ctx.userId,
        },
      ]);

      // Maintain invoices.paid transactionally so amountDue (total-paid) stays
      // consistent when vouchers are collected or cancelled (fix P0-LOGIC-3).
      if (input.invoiceId) {
        await tx
          .update(invoices)
          .set({ paid: sql`${invoices.paid} + ${input.amount}`, updatedAt: new Date() })
          .where(and(eq(invoices.id, input.invoiceId), eq(invoices.tenantId, ctx.tenantId)));
      }

      return this.toDomain(row);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<VoucherData> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
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
            eq(vouchers.id, id),
            eq(vouchers.tenantId, ctx.tenantId),
            eq(vouchers.status, "active"),
          ),
        )
        .returning();
      if (!row) throw new Error("Voucher not found or already cancelled");

      // Reverse the linked ledger entry atomically (mirrors invoice cancel).
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
              eq(ledgerEntries.referenceType, "payment_out"),
              eq(ledgerEntries.referenceType, "receipt_in"),
            ),
            eq(ledgerEntries.status, "active"),
          ),
        );

      // Reverse the invoice paid counter when a receipt/payment is cancelled
      if (row.invoiceId) {
        await tx
          .update(invoices)
          .set({ paid: sql`GREATEST(0, ${invoices.paid} - ${row.amount})`, updatedAt: new Date() })
          .where(and(eq(invoices.id, row.invoiceId), eq(invoices.tenantId, ctx.tenantId)));
      }

      return this.toDomain(row);
    });
  }

  private toDomain(row: typeof vouchers.$inferSelect): VoucherData {
    return Voucher.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof vouchers.$inferSelect): VoucherData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind as VoucherData["kind"],
      number: row.number,
      date: row.date,
      partyId: row.partyId,
      partyKind: row.partyKind as VoucherData["partyKind"],
      invoiceId: n(row.invoiceId),
      amount: row.amount,
      currency: row.currency,
      method: row.method as VoucherData["method"],
      status: row.status as VoucherData["status"],
      notesPrint: n(row.notesPrint),
      notesInternal: n(row.notesInternal),
      attachments: (row.attachments as unknown as unknown[]) ?? [],
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      createdBy: n(row.createdBy),
      updatedAt: row.updatedAt.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString(),
      cancelledBy: n(row.cancelledBy),
    };
  }
}
