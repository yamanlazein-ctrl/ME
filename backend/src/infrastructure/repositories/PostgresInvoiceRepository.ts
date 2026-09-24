import { eq, and, ilike, or, sql, inArray, gte, lte, desc, getTableColumns } from "drizzle-orm";
import { afterCursor, cursorColumns, decodeCursor, keysetOrder, nextCursorOf, type KeysetSpec } from "./keysetPage.js";
import { likeContains } from "../utils/likeEscape.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
import type { DB } from "../orm/drizzle.js";
import type {
  IInvoiceRepository,
  InvoiceFilter,
} from "../../application/ports/IInvoiceRepository.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { invoiceLines } from "../orm/schemas/invoice-line.table.js";
import { rolls } from "../orm/schemas/roll.table.js";
import { colors } from "../orm/schemas/color.table.js";
import { parties } from "../orm/schemas/party.table.js";
import { orders } from "../orm/schemas/order.table.js";
import { orderItems } from "../orm/schemas/order-item.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { recordStockMovement } from "./stockMovementHelper.js";
import { notifyOrderAvailability } from "./orderAvailabilityNotifier.js";
import { assertDayUnlocked } from "./dayLockHelper.js";
import { assertSufficientCashboxBalance } from "./cashboxBalanceHelper.js";
import { assertCreditNotOverdrawn, customerCreditPosition } from "./customerCredit.js";
import { returns } from "../orm/schemas/return.table.js";
import type {
  InvoiceData,
  CreateInvoiceInput,
  UpdateInvoiceInput,
} from "../../domain/entities/Invoice.js";
import { Invoice, computeSubtotal } from "../../domain/entities/Invoice.js";
import {
  round2dp,
  invoiceTotal,
  BASE_CURRENCY,
  computeBaseEquivalent,
  isValidFxRate,
  saneSypRateError,
  FX_REQUIRED_MESSAGE,
} from "@erp/shared";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { BusinessRuleError } from "../../domain/errors/index.js";
import { resolveSaleCostPerKg } from "../../domain/invoices/invoiceCostSnapshot.js";
import { resolveSaleLineCogs } from "../../domain/invoices/saleCogsConversion.js";
import { randomUUID } from "node:crypto";

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
      conditions.push(
        or(
          ilike(invoices.number, likeContains(filter.search)),
          ilike(invoices.reference, likeContains(filter.search)),
        )!,
      );
    }
    const where = and(...conditions);
    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;
    // Keyset mode for "load every row" callers: seek after the cursor instead
    // of OFFSET (constant cost per page, strict total order). keysetPage.ts.
    const keyset: KeysetSpec = { date: invoices.date, createdAt: invoices.createdAt, id: invoices.id };
    const cursor = true ? decodeCursor(filter.cursor) : null;
    const pageWhere = cursor ? and(where, afterCursor(keyset, cursor)) : where;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({ ...getTableColumns(invoices), ...cursorColumns(keyset) })
        .from(invoices)
        .where(pageWhere)
        .limit(limit)
        .offset(cursor ? 0 : offset)
        // Newest first: order by business date descending (createdAt as tiebreaker),
        // so the latest entered invoice is always at the top of the list.
        .orderBy(...keysetOrder(keyset)),
      // Cursor pages skip the COUNT: the caller stops on nextCursor and the
      // first (cursor-less) page already carried the real total.
      cursor
        ? Promise.resolve([{ count: -1 }])
        : this.db
            .select({ count: sql<number>`count(*)` })
            .from(invoices)
            .where(where),
    ]);

    const ids = dataRows.map((r) => r.id);
    const items =
      ids.length > 0
        ? await this.db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids))
        : [];
    const byId = new Map<string, typeof items>();
    for (const it of items) {
      const l = byId.get(it.invoiceId) ?? [];
      l.push(it);
      byId.set(it.invoiceId, l);
    }

    const nextCursor = nextCursorOf(dataRows as unknown as Array<Record<string, unknown>>, limit);
    return {
      data: dataRows.map((r) => this.toDomain(r, byId.get(r.id) ?? [])),
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

  async create(
    input: CreateInvoiceInput,
    ctx: TenantContext,
  ): Promise<InvoiceData> {
    const isSale = input.type === "sale";
    // Entity-type key is derived from input.type so the same repository method
    // can serve both entry and sale without the caller having to know which
    // document-sequence row to bump. The allocation happens INSIDE the insert
    // transaction below — see the H-NEW comment there.
    const entityType = isSale ? "invoice" : "invoice_entry";

    return this.db.transaction(async (tx) => {
      // H-NEW (forensic audit 2026-08-25, entry-invoice numbering): the
      // document number is allocated inside THIS transaction rather than
      // by the route handler before the transaction begins. If any guard
      // below throws — party-kind mismatch, stock insufficient, color/
      // fabric/currency mismatch, FK violation, check constraint — the
      // transaction rolls back and the sequence increment is undone
      // alongside the insert. A failed save therefore does NOT burn a
      // number, closing the gap pathology that previously produced
      // jumps like ENT-2026-0001 → ENT-2026-0005 on a retry.
      const autoNumber = await allocateDocumentNumber(tx, entityType, ctx.tenantId, {
        syncDeviceId: ctx.syncDeviceId,
        preAllocatedNumber: input.preAllocatedNumber,
      });

      const entity = Invoice.create(input, autoNumber);
      const inv = entity.toData();

      // H3 (party-kind guard): an entry invoice must target a supplier and a
      // sale invoice must target a customer. Without this check a sale posted
      // against a supplier party mixes AR/AP legs in one account.
      const expectedKind = isSale ? "customer" : "supplier";
      const [party] = await tx
        .select({ kind: parties.kind })
        .from(parties)
        .where(and(eq(parties.id, input.partyId), eq(parties.tenantId, ctx.tenantId)))
        .limit(1);
      if (!party) {
        throw new BusinessRuleError("الطرف المحدد للفاتورة غير موجود");
      }
      if (party.kind !== expectedKind) {
        throw new BusinessRuleError(
          isSale
            ? `لا يمكن إنشاء فاتورة بيع لطرف من نوع «${party.kind === "supplier" ? "مورد" : party.kind}» — اختر عميلاً`
            : `لا يمكن إنشاء فاتورة دخول لطرف من نوع «${party.kind === "customer" ? "عميل" : party.kind}» — اختر مورداً`,
        );
      }
      if (input.partyType !== expectedKind) {
        throw new BusinessRuleError("نوع الطرف في الفاتورة لا يطابق نوع الفاتورة");
      }

      // Customer credit (advance payments / earlier overpayments) applied to
      // this sale. Re-validated here against the live ledger — the client's
      // figure may be stale, and a synced replay on the hub must fail closed
      // (→ sync conflict) rather than mark an invoice paid with credit that
      // another device already spent.
      const creditApplied = isSale ? round2dp(input.creditApplied ?? 0) : 0;
      if (creditApplied > 0) {
        const position = await customerCreditPosition(
          tx,
          ctx.tenantId,
          input.partyId,
          input.currency ?? "SYP",
        );
        if (creditApplied > position.availableCredit + 0.01) {
          throw new BusinessRuleError(
            `الرصيد الدائن المتاح للعميل (${position.availableCredit} ${input.currency ?? "SYP"}) أقل من المبلغ المطلوب خصمه (${creditApplied})`,
          );
        }
      }
      // Cash that settles THIS invoice; anything above the total is customer credit.
      const cashPaid = input.paid ?? 0;
      const cashApplied = isSale ? round2dp(Math.min(cashPaid, inv.total)) : cashPaid;

      // Stock validation and deduction only for sale invoices.
      // Entry invoices add stock via roll creation — no deduction needed.
      const expectedVersions = new Map<string, number>();
      // C4+COGS: cost of goods sold for sale invoices = Σ(quantityKg × unitCost),
      // captured at sale time so it is journaled (not just derived at read time).
      // Sync replay may pin unitCost via line.costPerKg.
      let cogsTotal = 0;
      const costByRoll = new Map<string, string>();
      const invoiceCurrency = input.currency ?? "SYP";
      // BUG-03 fix — frozen FX rate for this document (units per 1 USD).
      const fxRate = isValidFxRate(input.exchangeRate)
        ? input.exchangeRate!
        : invoiceCurrency === BASE_CURRENCY
          ? 1
          : null;
      const legFx = (debit: number, credit: number) => ({
        exchangeRate: fxRate,
        baseDebit: computeBaseEquivalent(debit, invoiceCurrency, fxRate),
        baseCredit: computeBaseEquivalent(credit, invoiceCurrency, fxRate),
      });
      // QA fix (ENT-2026-0002): a non-USD invoice without a valid rate used to
      // slip through with NULL base_total / NULL ledger base_* columns — an
      // unconvertible document that breaks cross-currency sums and the
      // double-entry balance in the base currency. Fail closed instead: the
      // caller must supply the rate at creation time (the UI now enforces it
      // too). USD documents are always convertible (rate = 1).
      // Fail closed for non-USD without rate. USD invoices may still need a
      // caller-supplied rate when selling stock priced in another currency
      // (validated per-line when converting COGS).
      if (invoiceCurrency !== BASE_CURRENCY && !isValidFxRate(fxRate)) {
        throw new BusinessRuleError(FX_REQUIRED_MESSAGE);
      }
      // Sanity floor: a manually-typed SYP rate under 1,000 is never a real
      // market rate, only a dropped digit — this is the frozen rate every
      // later settlement voucher reuses, so catching it here (once, at
      // invoice creation) prevents it from propagating forward.
      const invoiceSypRateError = saneSypRateError(invoiceCurrency, fxRate);
      if (invoiceSypRateError) throw new BusinessRuleError(invoiceSypRateError);
      // Per-line guards: stock, color/fabric match, currency match.
      // Runs for BOTH sale and entry invoices (NEW-03 added entry arm).
      // The H1 cross-currency guard inside rejects when the roll's currency
      // does not match the invoice currency, so COGS and stock value stay
      // in one unit.
      // Per-line guards. The roll SELECT runs for BOTH sale and entry so
      // the entry arm gets the H1 cross-currency guard (NEW-03) and the
      // color/fabric integrity check. Stock sufficiency and COGS
      // accumulation are sale-only.
      // REPAIR-012: lock all rolls once, ascending id order.
      const { lockRollsOrdered } = await import("./rollLocking.js");
      const lockedRolls = await lockRollsOrdered(
        tx,
        ctx.tenantId,
        input.lines.map((l) => l.rollId),
      );
      for (const line of input.lines) {
        const locked = lockedRolls.get(line.rollId)!;
        const r = {
          kg: locked.remainingKg,
          version: locked.version,
          status: locked.status,
          pricePerKg: locked.pricePerKg,
          colorId: locked.colorId,
          currency: locked.currency,
          rollNo: locked.rollNo,
        };
        // BUG-04 / H-2: line.colorId must match the roll's real color.
        if (line.colorId !== r.colorId) {
          throw new BusinessRuleError(
            `لا يمكن تغيير لون الصبغة #${r.rollNo} بعد حفظها — لون البند المختار لا يطابق لون الصبغة المحفوظة. احذف البند وأضف صبغة جديدة باللون الصحيح.`,
          );
        }
        if (line.fabricId !== locked.fabricId) {
          throw new BusinessRuleError(
            `لا يمكن تغيير قماش الصبغة #${r.rollNo} بعد حفظها — قماش البند المختار لا يطابق قماش الصبغة المحفوظة.`,
          );
        }
        // Cross-currency: ENTRY still rejects (stock value integrity).
        // SALE allows it when a manual FX rate can convert roll cost → invoice currency
        // (owner: buy SYP / sell USD is a normal workflow).
        if (r.currency !== invoiceCurrency) {
          if (!isSale) {
            throw new BusinessRuleError(
              `عملة اللفافة ${r.rollNo} (${r.currency}) لا تطابق عملة الفاتورة (${invoiceCurrency}) — لا يمكن خلط العملات في التكلفة`,
            );
          }
        }
        // DIAG-أ (silent-error fix): an entry invoice must only stock a FRESH,
        // EMPTY roll. The frontend contract creates each roll with
        // remainingKg=0 right before the invoice (entry.new.tsx addRoll), and
        // the entry arm below increments remainingKg by the line quantity.
        // Without this cap, an API caller (or a stale UI) could reference an
        // already-stocked roll and silently inflate its stock — quantity 500
        // on a roll holding 406kg became 506kg with no resistance. Exhausted
        // rolls are rejected too so a sold-out roll cannot be resurrected.
        if (!isSale && (Number(r.kg) > 0 || r.status !== "in_stock")) {
          throw new BusinessRuleError(
            `فاتورة الدخول يجب أن تشير إلى لفافة جديدة فارغة — اللفافة ${r.rollNo} عليها مخزون حالي (${Number(r.kg)} كغ، حالة ${r.status}) ولا يمكن إضافة مخزون فوقها من فاتورة دخول`,
          );
        }
        if (isSale) {
          if (Number(r.kg) < line.quantityKg) {
            throw new BusinessRuleError(
              `اللفافة ${r.rollNo} المخزون غير كافٍ (${Number(r.kg)} كغ < ${line.quantityKg} كغ)`,
            );
          }
          if (r.status === "exhausted") {
            throw new BusinessRuleError(`اللفافة ${r.rollNo} نفدت ولا يمكن بيعها`);
          }
          expectedVersions.set(line.rollId, Number(r.version));
          const storedQty = Math.round(Number(line.quantityKg) * 100) / 100;
          const unitCost = resolveSaleCostPerKg(line.costPerKg, Number(r.pricePerKg));
          const rollCostNative = round2dp(storedQty * unitCost);
          cogsTotal += resolveSaleLineCogs(
            rollCostNative,
            r.currency,
            invoiceCurrency,
            input.exchangeRate,
          );
          if (!costByRoll.has(line.rollId)) {
            costByRoll.set(line.rollId, String(unitCost));
          }
        }
      }

      const [row] = await tx
        .insert(invoices)
        .values({
          ...(input.preAllocatedId ? { id: input.preAllocatedId } : {}),
          tenantId: ctx.tenantId,
         number: autoNumber,
         // Reference = user-supplied value or the server-generated number.
         // Screen, API and print all read this single structured field.
         reference: input.reference?.trim() || autoNumber,
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
          paid: round2dp(cashApplied + creditApplied),
          creditApplied,
          paymentMethod: (input.paid ?? 0) > 0 ? (input.paymentMethod ?? "cash") : null,
          notes: input.notes,
          // BUG-03 fix — frozen FX capture at creation time (mirrors fx.ts rule):
          // non-USD documents require a positive rate for base_* conversion.
          // USD documents remain base-native (computeBaseEquivalent ignores rate)
          // but still persist a caller-supplied market rate when provided.
          exchangeRate: fxRate,
          baseTotal: computeBaseEquivalent(inv.total, invoiceCurrency, fxRate),
          createdBy: ctx.userId,
          clientOperationId: ctx.clientOperationId ?? null,
        })
        .returning();

      // Capture cost snapshot for sale lines so returns can be valued at cost (fix 3.6c)
      // (unit costs already collected in costByRoll during the validation loop).
      if (isSale) {
        for (const l of input.lines) {
          if (!costByRoll.has(l.rollId)) {
            const [rollCost] = await tx
              .select({ pricePerKg: rolls.pricePerKg })
              .from(rolls)
              .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)))
              .limit(1);
            costByRoll.set(
              l.rollId,
              String(
                resolveSaleCostPerKg(
                  l.costPerKg,
                  rollCost ? Number(rollCost.pricePerKg) : Number(l.pricePerKg),
                ),
              ),
            );
          }
        }
      }
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
          costPerKg: isSale ? (costByRoll.get(l.rollId) ?? String(l.pricePerKg)) : null,
          note: l.note,
        })),
      );

      // Deduct stock — sale invoices only. Rolls already locked via lockRollsOrdered;
      // aggregate by rollId and apply updates in ascending id order (REPAIR-012).
      if (isSale) {
        const saleAgg = new Map<string, { kg: number; pieces: number }>();
        for (const line of input.lines) {
          const prev = saleAgg.get(line.rollId) ?? { kg: 0, pieces: 0 };
          saleAgg.set(line.rollId, {
            kg: prev.kg + line.quantityKg,
            pieces: prev.pieces + (line.pieces ?? 1),
          });
        }
        for (const rollId of [...saleAgg.keys()].sort()) {
          const agg = saleAgg.get(rollId)!;
          const locked = lockedRolls.get(rollId)!;
          const r = {
            remainingKg: Number(locked.remainingKg),
            remainingPieces: Number(locked.remainingPieces),
            rollNo: locked.rollNo,
          };
          if (agg.pieces > r.remainingPieces) {
            throw new BusinessRuleError(
              `عدد الأثواب المطلوب (${agg.pieces}) يتجاوز المتاح في الصبغة (${r.remainingPieces} أثواب)`,
            );
          }
          const newKg = Math.max(0, r.remainingKg - agg.kg);
          const newPieces = Math.max(0, r.remainingPieces - agg.pieces);
          const expectedVersion = expectedVersions.get(rollId);
          const updated = await tx
            .update(rolls)
            .set({
              remainingKg: String(newKg),
              remainingPieces: newPieces,
              status: sql`CASE WHEN ${String(newKg)} <= '0' THEN 'exhausted' ELSE ${rolls.status} END`,
              version: sql`${rolls.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(rolls.id, rollId),
                eq(rolls.tenantId, ctx.tenantId),
                eq(rolls.version, expectedVersion ?? 0),
              ),
            )
            .returning({ id: rolls.id });
          if (updated.length === 0) {
            throw new BusinessRuleError(
              `تعارض على اللفافة ${r.rollNo} — تم تعديلها من جهاز آخر. حدّث الصفحة وأعد المحاولة.`,
            );
          }
          await recordStockMovement(
            tx,
            {
              rollId,
              direction: "out",
              movementType: "invoice_sale",
              quantityKg: agg.kg,
              balanceAfterKg: newKg,
              referenceType: "sales_invoice",
              referenceId: row.id,
              referenceNumber: autoNumber,
              movementDate: input.date,
              description: `فاتورة بيع ${autoNumber}`,
            },
            ctx,
          );
        }
      }

      // Entry invoices ADD stock. Rolls already locked; apply in id order.
      if (!isSale) {
        const entryAgg = new Map<
          string,
          { kg: number; pieces: number; colorId: string; fabricId: string }
        >();
        for (const line of input.lines) {
          const prev = entryAgg.get(line.rollId);
          if (prev) {
            entryAgg.set(line.rollId, {
              kg: prev.kg + line.quantityKg,
              pieces: prev.pieces + (line.pieces ?? 1),
              colorId: prev.colorId,
              fabricId: prev.fabricId,
            });
          } else {
            entryAgg.set(line.rollId, {
              kg: line.quantityKg,
              pieces: line.pieces ?? 1,
              colorId: line.colorId,
              fabricId: line.fabricId,
            });
          }
        }
        for (const rollId of [...entryAgg.keys()].sort()) {
          const agg = entryAgg.get(rollId)!;
          const locked = lockedRolls.get(rollId)!;
          if (agg.colorId !== locked.colorId) {
            throw new BusinessRuleError(
              `لا يمكن تغيير لون الصبغة #${locked.rollNo} بعد حفظها — لون البند المختار لا يطابق لون الصبغة المحفوظة. احذف البند وأضف صبغة جديدة باللون الصحيح.`,
            );
          }
          if (agg.fabricId !== locked.fabricId) {
            throw new BusinessRuleError(
              `القماش المحدد للبند لا يطابق قماش لون اللفافة ${locked.rollNo} الفعلي`,
            );
          }
          const newKg = Number(locked.remainingKg) + agg.kg;
          await tx
            .update(rolls)
            .set({
              remainingKg: sql`${rolls.remainingKg} + ${agg.kg}`,
              remainingPieces: sql`${rolls.remainingPieces} + ${agg.pieces}`,
              status: sql`CASE WHEN ${rolls.remainingKg} + ${agg.kg} > 0 THEN 'in_stock' ELSE ${rolls.status} END`,
              version: sql`${rolls.version} + 1`,
              updatedAt: new Date(),
            })
            .where(and(eq(rolls.id, rollId), eq(rolls.tenantId, ctx.tenantId)));
          await recordStockMovement(
            tx,
            {
              rollId,
              direction: "in",
              movementType: "invoice_entry",
              quantityKg: agg.kg,
              balanceAfterKg: newKg,
              referenceType: "purchase_invoice",
              referenceId: row.id,
              referenceNumber: autoNumber,
              movementDate: input.date,
              description: `فاتورة شراء ${autoNumber}`,
            },
            ctx,
          );
        }
        await notifyOrderAvailability(
          tx,
          ctx,
          input.lines.map((l) => l.colorId),
        );
      }

      // Write ledger entry — C4 fix: double-entry via shared invoiceLedgerLegs
      // so create and update cannot drift. Paid-linked voucher legs stay below.
      const invoiceType = isSale ? "sales_invoice" : "purchase_invoice";
      const currency = invoiceCurrency;
      const legs = this.invoiceLedgerLegs({
        tenantId: ctx.tenantId,
        partyId: input.partyId,
        date: input.date,
        currency,
        fxRate,
        isSale,
        total: inv.total,
        cogsTotal,
        referenceId: row.id,
        referenceNumber: autoNumber,
        createdBy: ctx.userId,
      });
      await tx.insert(ledgerEntries).values(legs);

      // Linked receipt voucher for cash/on-account payments at sale time.
      // A partial or full payment (paid > 0) creates a linked receipt voucher
      // (number RCP-<invoiceNo>) plus a receipt_in ledger entry, all atomically.
      const paid = input.paid ?? 0;
      // OI-7: a cash-paid invoice (paid > 0 + cash method) writes a cash ledger
      // leg (cashImpact in/out) and moves the cashbox — reject it on a closed
      // day, using the same atomic guard as vouchers/expenses/manual movements.
      if (paid > 0 && (input.paymentMethod ?? "cash") === "cash") {
        await assertDayUnlocked(tx, ctx.tenantId, input.date);
      }
      let linkedVoucherId: string | null = null;
      if (isSale && paid > 0) {
        // Overpayment is accepted: the receipt carries the FULL cash (cash leg
        // + customer credit leg below), the invoice only takes `cashApplied`,
        // and the excess stays on the customer's ledger as credit.
        const method = input.paymentMethod ?? "cash";
        const receiptNumber = `RCP-${autoNumber}`;
        linkedVoucherId = input.linkedVoucherId ?? randomUUID();
        const [voucherRow] = await tx
          .insert(vouchers)
          .values({
            id: linkedVoucherId,
            tenantId: ctx.tenantId,
            kind: "receipt",
            number: receiptNumber,
            date: input.date,
            partyId: input.partyId,
            partyKind: "customer",
            invoiceId: row.id,
            amount: paid,
            appliedAmount: cashApplied,
            discount: 0,
            currency: input.currency ?? "SYP",
            // QA fix: the linked receipt voucher must freeze the same FX rate
            // as its invoice — it was omitted here, leaving base_amount NULL
            // even when the invoice had a valid rate.
            exchangeRate: fxRate,
            baseAmount: computeBaseEquivalent(paid, invoiceCurrency, fxRate),
            method,
            notesPrint:
              paid > cashApplied + 0.01
                ? `قبض مرتبط بالفاتورة ${autoNumber} — منه ${round2dp(paid - cashApplied)} دفعة مقدمة لرصيد العميل`
                : `قبض مرتبط بالفاتورة ${autoNumber}`,
            createdBy: ctx.userId,
          })
          .returning({ id: vouchers.id });
        linkedVoucherId = voucherRow.id;

        await tx.insert(ledgerEntries).values([
          {
            ...legFx(0, paid),
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
            description: `سند قبض ${receiptNumber}`,
            createdBy: ctx.userId,
          },
          {
            ...legFx(paid, 0),
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
            description: `نقدية مقبوضة ${receiptNumber}`,
            createdBy: ctx.userId,
          },
        ]);
      }

      // Linked supplier-payment voucher for entry (purchase) invoices paid at
      // billing time. Posts Dr party / Cr cash (canonical payment) so AP becomes
      // total − paid (= invoice.amountDue).
      if (!isSale && paid > 0) {
        if (paid > inv.total) {
          throw new BusinessRuleError(`المبلغ المدفوع (${paid}) أكبر من إجمالي الفاتورة (${inv.total})`);
        }
        const method = input.paymentMethod ?? "cash";
        // F06 gap: a cash-paid purchase invoice removes cash from the cashbox
        // exactly like a payment voucher — it must be guarded the same way
        // (comment above claimed this already happened; it never did).
        if (method === "cash") {
          await assertSufficientCashboxBalance(
            tx,
            ctx,
            input.currency ?? "SYP",
            input.date,
            paid,
          );
        }
        const paymentNumber = `PAY-${autoNumber}`;
        linkedVoucherId = input.linkedVoucherId ?? randomUUID();
        const [voucherRow] = await tx
          .insert(vouchers)
          .values({
            id: linkedVoucherId,
            tenantId: ctx.tenantId,
            kind: "payment",
            number: paymentNumber,
            date: input.date,
            partyId: input.partyId,
            partyKind: "supplier",
            invoiceId: row.id,
            amount: paid,
            discount: 0,
            currency: input.currency ?? "SYP",
            // QA fix (ENT-2026-0002): the linked supplier-payment voucher never
            // froze its FX capture — PAY-ENT-2026-0002 shipped with NULL
            // exchange_rate / base_amount even though the invoice rate existed.
            exchangeRate: fxRate,
            baseAmount: computeBaseEquivalent(paid, invoiceCurrency, fxRate),
            method,
            notesPrint: `دفعة مرتبطة بالفاتورة ${autoNumber}`,
            createdBy: ctx.userId,
          })
          .returning({ id: vouchers.id });
        linkedVoucherId = voucherRow.id;

        const cashImpact = method === "cash" ? "out" : "none";
        await tx.insert(ledgerEntries).values([
          {
            ...legFx(paid, 0),
            tenantId: ctx.tenantId,
            partyId: input.partyId,
            date: input.date,
            type: "payment_out",
            // Canonical supplier payment: Dr party / Cr cash (same as
            // PostgresVoucherRepository + migration 0040). Crediting the
            // supplier here inverted AP and inflated the statement balance.
            debit: paid,
            credit: 0,
            currency: input.currency ?? "SYP",
            cashImpact: "none",
            referenceType: "payment_out",
            referenceId: voucherRow.id,
            referenceNumber: paymentNumber,
            description: `سند دفع ${paymentNumber}`,
            createdBy: ctx.userId,
          },
          {
            ...legFx(0, paid),
            tenantId: ctx.tenantId,
            partyId: null,
            date: input.date,
            type: "cash",
            debit: 0,
            credit: paid,
            currency: input.currency ?? "SYP",
            cashImpact,
            referenceType: "payment_out",
            referenceId: voucherRow.id,
            referenceNumber: paymentNumber,
            description: `نقدية مدفوعة ${paymentNumber}`,
            createdBy: ctx.userId,
          },
        ]);
      }

      const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, row.id));
      const domain = this.toDomain(row, lines);
      return { ...domain, linkedVoucherId };
    });
  }

  async update(id: string, input: UpdateInvoiceInput, ctx: TenantContext, expectedVersion: number): Promise<InvoiceData> {
    const lines = input.lines.map((l) => ({
      fabricId: l.fabricId,
      colorId: l.colorId,
      rollId: l.rollId,
      quantityKg: l.quantityKg,
      pieces: l.pieces ?? 1,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount ?? 0,
      note: l.note?.trim(),
    }));
    // FIN-01: the edit path reuses the same money authority as create/validate.
    const subtotal = computeSubtotal(lines as never);
    const discount = input.discount ?? 0;
    const tax = input.tax ?? 0;
    const shipping = input.shipping ?? 0;
    const total = invoiceTotal({ lines: lines as never, discount, tax, shipping });

    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.tenantId, ctx.tenantId)))
        .for("update")
        .limit(1);
      if (!inv) throw Object.assign(new Error("Invoice not found"), { code: "NOT_FOUND" as const });
      if (inv.status === "cancelled")
        throw Object.assign(new Error("Invoice already cancelled"), {
          code: "ALREADY_CANCELLED" as const,
        });
      // P0-001: optimistic concurrency — fail fast if version mismatch
      if (inv.version !== expectedVersion) {
        throw Object.assign(new Error(`Stale version: expected ${expectedVersion}, current ${inv.version}`), {
          code: "STALE_VERSION" as const,
        });
      }

      // The invoice may already have voucher/settlement payments recorded
      // against it (`inv.paid`, maintained transactionally by
      // PostgresVoucherRepository / PostgresStatementRepository). Shrinking
      // the total below what has already been paid would make amountDue
      // (total - paid) negative — an invalid state the statement, ledger,
      // and cashbox all assume can never happen.
      if (round2dp(total) < round2dp(Number(inv.paid))) {
        throw new BusinessRuleError(
          `لا يمكن تعديل إجمالي الفاتورة إلى ${round2dp(total)} لأنه أقل من المبلغ المدفوع بالفعل (${round2dp(Number(inv.paid))}). عدّل بنود الفاتورة بحيث لا يقل الإجمالي عن المبلغ المدفوع، أو ألغِ/عدّل الدفعة أولاً.`,
        );
      }

      const isSale = inv.type === "sale";
      const invoiceType = isSale ? "sales_invoice" : "purchase_invoice";

      const oldLines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id));

      // Aggregate both old and new quantities per roll so a roll moved across
      // lines (or duplicated) nets out to one delta instead of double-counting.
      const oldByRoll = new Map<string, { kg: number; pieces: number }>();
      const oldCostByRoll = new Map<string, number>();
      for (const l of oldLines) {
        const e = oldByRoll.get(l.rollId) ?? { kg: 0, pieces: 0 };
        e.kg += Number(l.quantityKg);
        e.pieces += Number(l.pieces ?? 1);
        oldByRoll.set(l.rollId, e);
        if (l.costPerKg != null && !oldCostByRoll.has(l.rollId)) {
          const n = Number(l.costPerKg);
          if (Number.isFinite(n)) oldCostByRoll.set(l.rollId, n);
        }
      }
      const newByRoll = new Map<string, { kg: number; pieces: number; fabricId: string; colorId: string }>();
      for (const l of lines) {
        const e = newByRoll.get(l.rollId) ?? {
          kg: 0,
          pieces: 0,
          fabricId: l.fabricId,
          colorId: l.colorId,
        };
        e.kg += l.quantityKg;
        e.pieces += l.pieces;
        newByRoll.set(l.rollId, e);
      }

      const rollIds = new Set([...oldByRoll.keys(), ...newByRoll.keys()]);
      const rollStates = new Map<
        string,
        {
          remainingKg: number;
          remainingPieces: number;
          pricePerKg: number;
          colorId: string;
          currency: string;
          version: number;
          status: string;
          rollNo: string;
        }
      >();
      const deltas = new Map<string, { kg: number; pieces: number }>();

      // REPAIR-012: lock all rolls once in ascending id order.
      const { lockRollsOrdered } = await import("./rollLocking.js");
      const lockedRolls = await lockRollsOrdered(tx, ctx.tenantId, [...rollIds], {
        notFoundMessage: "اللفافة المحددة غير موجودة",
      });
      for (const rollId of [...rollIds].sort()) {
        const r = lockedRolls.get(rollId)!;
        const next = newByRoll.get(rollId);
        if (next) {
          if (next.colorId !== r.colorId) {
            throw new BusinessRuleError(`لا يمكن تغيير لون الصبغة #${r.rollNo} بعد حفظها — لون البند المختار لا يطابق لون الصبغة المحفوظة. احذف البند وأضف صبغة جديدة باللون الصحيح.`);
          }
          if (next.fabricId !== r.fabricId) {
            throw new BusinessRuleError(`القماش المحدد للبند لا يطابق قماش لون اللفافة ${r.rollNo} الفعلي`);
          }
        }

        const old = oldByRoll.get(rollId) ?? { kg: 0, pieces: 0 };
        const neu = newByRoll.get(rollId) ?? { kg: 0, pieces: 0 };
        deltas.set(rollId, {
          kg: Math.round((neu.kg - old.kg) * 100) / 100,
          pieces: neu.pieces - old.pieces,
        });
        rollStates.set(rollId, {
          remainingKg: Number(r.remainingKg),
          remainingPieces: Number(r.remainingPieces),
          pricePerKg: Number(r.pricePerKg),
          colorId: r.colorId,
          currency: r.currency,
          version: Number(r.version),
          status: r.status,
          rollNo: r.rollNo,
        });
      }

      // Apply per-roll stock deltas. Entry invoices ADD stock, sale invoices
      // DEDUCT it; a negative delta therefore reverses the original direction.
      for (const [rollId, delta] of deltas) {
        const state = rollStates.get(rollId)!;
        const kgDelta = isSale ? -delta.kg : delta.kg;
        const piecesDelta = isSale ? -delta.pieces : delta.pieces;
        const newKg = Math.round((state.remainingKg + kgDelta) * 100) / 100;
        const newPieces = state.remainingPieces + piecesDelta;

        // DIAG-أ (silent-error fix, v2 — delta-based): cap entry quantity
        // increases against the roll's REAL unsold stock at edit time.
        // `state.remainingKg` is read fresh (FOR UPDATE) before this request's
        // deltas are applied, and `delta` is the per-roll AGGREGATE of the
        // whole PUT (newByRoll/oldByRoll), so a request touching the same roll
        // on multiple lines cannot double-count. Rules:
        //  - delta.kg <= 0 (decrease / hold): always allowed.
        //  - delta.kg > 0 (increase): allowed only while the roll still holds
        //    at least that much unsold stock (delta <= remaining_kg).
        //  - A roll introduced by this edit must still be a fresh, empty,
        //    in-stock roll (mirrors the create-path cap).
        if (!isSale && newByRoll.has(rollId)) {
          if (!oldByRoll.has(rollId)) {
            if (state.remainingKg !== 0 || state.status !== "in_stock") {
              throw new BusinessRuleError(
                `لا يمكن إدخال اللفافة ${state.rollNo} عبر تعديل فاتورة — عليها مخزون حالي (${state.remainingKg} كغ، حالة ${state.status}). أنشئ فاتورة دخول جديدة.`,
              );
            }
          } else {
            if (delta.kg > state.remainingKg) {
              throw new BusinessRuleError(
                `لا يمكن زيادة كمية الدخول بمقدار ${delta.kg} كغ — المتاح غير المباع في اللفافة ${state.rollNo} هو ${state.remainingKg} كغ فقط`,
              );
            }
            if (delta.pieces > state.remainingPieces) {
              throw new BusinessRuleError(
                `لا يمكن زيادة عدد أثواب الدخول بمقدار ${delta.pieces} — المتاح غير المباع في اللفافة ${state.rollNo} هو ${state.remainingPieces} أثواب فقط`,
              );
            }
          }
        }

        if (newKg < 0) {
          throw new BusinessRuleError(
            isSale
              ? `لا يمكن زيادة كمية البيع — المتاح في اللفافة ${state.rollNo} غير كافٍ`
              : `لا يمكن إنقاص كمية الدخول — المتاح في اللفافة ${state.rollNo} غير كافٍ`,
          );
        }
        if (newPieces < 0) {
          throw new BusinessRuleError(
            `الأثواب الناتجة عن التعديل تتجاوز المتاح في اللفافة ${state.rollNo}`,
          );
        }

        await tx
          .update(rolls)
          .set({
            remainingKg: String(newKg),
            remainingPieces: newPieces,
            status: newKg <= 0 ? "exhausted" : "in_stock",
            version: sql`${rolls.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(rolls.id, rollId), eq(rolls.tenantId, ctx.tenantId)));

        if (Math.round(kgDelta * 100) / 100 !== 0) {
          await recordStockMovement(
            tx,
            {
              rollId,
              direction: kgDelta > 0 ? "in" : "out",
              movementType: isSale ? "invoice_sale" : "invoice_entry",
              quantityKg: Math.abs(kgDelta),
              balanceAfterKg: newKg,
              referenceType: invoiceType,
              referenceId: id,
              referenceNumber: inv.number,
              movementDate: input.date,
              description: `تعديل فاتورة ${inv.number}`,
            },
            ctx,
          );
        }
      }

      // Historical FX is frozen at create time. Edits may restate quantities and
      // unit prices in the document currency, but must NOT revalue the document
      // by substituting a new exchangeRate (shared schema: never silently
      // re-value a historical doc). Cross-currency COGS conversion uses the
      // same frozen rate.
      // FX-FREEZE FIX: prefer the STORED create-time rate. A USD document may
      // legitimately carry a manually-supplied rate (needed to convert COGS of
      // stock priced in another currency), so forcing 1 for every USD invoice
      // BEFORE consulting the stored rate silently destroyed that frozen rate
      // on any edit. Fall back to 1 only when no valid rate was ever stored.
      const storedFx = isValidFxRate(inv.exchangeRate)
        ? Number(inv.exchangeRate)
        : null;
      const frozenFx = storedFx ?? (inv.currency === BASE_CURRENCY ? 1 : null);
      if (inv.currency !== BASE_CURRENCY && !isValidFxRate(frozenFx)) {
        throw new BusinessRuleError(FX_REQUIRED_MESSAGE);
      }
      if (
        input.exchangeRate != null &&
        isValidFxRate(input.exchangeRate) &&
        frozenFx != null &&
        Math.abs(Number(input.exchangeRate) - frozenFx) > 1e-9
      ) {
        throw new BusinessRuleError(
          `لا يمكن تغيير سعر الصرف التاريخي للفاتورة (المجمّد ${frozenFx}). أنشئ مستنداً جديداً إذا تغيّر السعر.`,
        );
      }
      const editFx = frozenFx!;

      // Cost snapshot for sale lines — convert roll-native cost → invoice currency via FX.
      let cogsTotal = 0;
      if (isSale) {
        for (const l of lines) {
          const state = rollStates.get(l.rollId)!;
          const storedQty = Math.round(l.quantityKg * 100) / 100;
          const unitCost = resolveSaleCostPerKg(oldCostByRoll.get(l.rollId), state.pricePerKg);
          const rollCostNative = round2dp(storedQty * unitCost);
          // Prefer the invoice's own frozen rate (edits must not revalue a
          // historical document via a new rate — see comment above); fall
          // back to the caller-supplied rate only when the invoice itself
          // has none (e.g. a USD-native document with no frozen FX yet).
          const editRate = isValidFxRate(editFx)
            ? editFx
            : isValidFxRate(input.exchangeRate)
              ? input.exchangeRate!
              : null;
          cogsTotal += resolveSaleLineCogs(rollCostNative, state.currency, inv.currency, editRate);
        }
      }
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
      await tx.insert(invoiceLines).values(
        lines.map((l) => ({
          tenantId: ctx.tenantId,
          invoiceId: id,
          fabricId: l.fabricId,
          colorId: l.colorId,
          rollId: l.rollId,
          quantityKg: String(l.quantityKg),
          pieces: l.pieces,
          pricePerKg: String(l.pricePerKg),
          discountAmount: l.discountAmount,
          costPerKg: isSale
            ? String(
                resolveSaleCostPerKg(
                  oldCostByRoll.get(l.rollId),
                  rollStates.get(l.rollId)!.pricePerKg,
                ),
              )
            : null,
          note: l.note,
        })),
      );

      // Ledger is append-only (trigger 0013). Rewrite by soft-cancelling the
      // invoice's original legs and inserting freshly-valued ones in the same
      // transaction — no UPDATE of immutable financial columns.
      await tx
        .update(ledgerEntries)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: ctx.userId,
        })
        .where(
          and(
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.referenceType, invoiceType),
            eq(ledgerEntries.status, "active"),
          ),
        );

      await tx.insert(ledgerEntries).values(
        this.invoiceLedgerLegs({
          tenantId: ctx.tenantId,
          partyId: inv.partyId,
          date: input.date,
          currency: inv.currency,
          fxRate: editFx,
          isSale,
          total,
          cogsTotal,
          referenceId: id,
          referenceNumber: inv.number,
          createdBy: ctx.userId,
        }),
      );

      const [updated] = await tx
        .update(invoices)
        .set({
          date: input.date,
          subtotal: round2dp(subtotal),
          discount: round2dp(discount),
          tax: round2dp(tax),
          shipping: round2dp(shipping),
          total: round2dp(total),
          notes: input.notes ?? null,
          // Keep the create-time FX freeze; edits must not rewrite exchangeRate.
          exchangeRate: editFx,
          baseTotal: computeBaseEquivalent(total, inv.currency, editFx),
          updatedAt: new Date(),
          version: sql`${invoices.version} + 1`,
        })
        .where(and(eq(invoices.id, id), eq(invoices.tenantId, ctx.tenantId)))
        .returning();

      const updatedLines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id));
      return this.toDomain(updated, updatedLines);
    });
  }

  /** Build the invoice's own balanced ledger legs (excludes paid-linked voucher legs). */
  private invoiceLedgerLegs(args: {
    tenantId: string;
    partyId: string;
    date: string;
    currency: string;
    /** Frozen FX rate (units of `currency` per 1 USD); USD documents pass 1. */
    fxRate?: number | null;
    isSale: boolean;
    total: number;
    cogsTotal: number;
    referenceId: string;
    referenceNumber: string;
    createdBy: string | undefined;
  }): (typeof ledgerEntries.$inferInsert)[] {
    const invoiceType = args.isSale ? "sales_invoice" : "purchase_invoice";
    // QA fix (ENT-2026-0002): rewritten legs must carry the frozen FX capture —
    // previously exchange_rate / base_debit / base_credit were never set here.
    const legFx = (debit: number, credit: number) => ({
      exchangeRate: args.fxRate ?? null,
      baseDebit: computeBaseEquivalent(debit, args.currency, args.fxRate),
      baseCredit: computeBaseEquivalent(credit, args.currency, args.fxRate),
    });
    const legs: (typeof ledgerEntries.$inferInsert)[] = [
      {
        ...legFx(args.isSale ? args.total : 0, args.isSale ? 0 : args.total),
        tenantId: args.tenantId,
        partyId: args.partyId,
        date: args.date,
        type: invoiceType,
        // Standard double-entry (matches the create path and the supplier
        // "credit = owed" statement convention): sale → Dr party (AR),
        // purchase → Cr party (AP). Create and edit must agree so an edit
        // never flips the party's balance direction.
        debit: args.isSale ? args.total : 0,
        credit: args.isSale ? 0 : args.total,
        currency: args.currency,
        cashImpact: "none",
        referenceType: invoiceType,
        referenceId: args.referenceId,
        referenceNumber: args.referenceNumber,
        description: `${args.isSale ? "فاتورة بيع" : "فاتورة شراء"} ${args.referenceNumber}`,
        createdBy: args.createdBy,
      },
    ];
    if (args.isSale) {
      legs.push({
        ...legFx(0, args.total),
        tenantId: args.tenantId,
        partyId: null,
        date: args.date,
        type: "sales_revenue",
        debit: 0,
        credit: args.total,
        currency: args.currency,
        cashImpact: "none",
        referenceType: invoiceType,
        referenceId: args.referenceId,
        referenceNumber: args.referenceNumber,
        description: `إيراد مبيعات ${args.referenceNumber}`,
        createdBy: args.createdBy,
      });
      if (args.cogsTotal > 0) {
        legs.push({
          ...legFx(args.cogsTotal, 0),
          tenantId: args.tenantId,
          partyId: null,
          date: args.date,
          type: "cogs_expense",
          debit: args.cogsTotal,
          credit: 0,
          currency: args.currency,
          cashImpact: "none",
          referenceType: invoiceType,
          referenceId: args.referenceId,
          referenceNumber: args.referenceNumber,
          description: `تكلفة البضاعة المباعة ${args.referenceNumber}`,
          createdBy: args.createdBy,
        });
        legs.push({
          ...legFx(0, args.cogsTotal),
          tenantId: args.tenantId,
          partyId: null,
          date: args.date,
          type: "inventory_asset",
          debit: 0,
          credit: args.cogsTotal,
          currency: args.currency,
          cashImpact: "none",
          referenceType: invoiceType,
          referenceId: args.referenceId,
          referenceNumber: args.referenceNumber,
          description: `تخفيض مخزون ${args.referenceNumber}`,
          createdBy: args.createdBy,
        });
      }
    } else {
      legs.push({
        ...legFx(args.total, 0),
        tenantId: args.tenantId,
        partyId: null,
        date: args.date,
        type: "inventory_asset",
        debit: args.total,
        credit: 0,
        currency: args.currency,
        cashImpact: "none",
        referenceType: invoiceType,
        referenceId: args.referenceId,
        referenceNumber: args.referenceNumber,
        description: `مخزون مستلم ${args.referenceNumber}`,
        createdBy: args.createdBy,
      });
    }
    return legs;
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext, expectedVersion: number): Promise<InvoiceData> {
    return this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.tenantId, ctx.tenantId)))
        .for("update")
        .limit(1);
      if (!inv) throw Object.assign(new Error("Invoice not found"), { code: "NOT_FOUND" as const });
      if (inv.status === "cancelled")
        throw Object.assign(new Error("Invoice already cancelled"), {
          code: "ALREADY_CANCELLED" as const,
        });
      // P0-001: optimistic concurrency — fail fast if version mismatch
      if (inv.version !== expectedVersion) {
        throw Object.assign(new Error(`Stale version: expected ${expectedVersion}, current ${inv.version}`), {
          code: "STALE_VERSION" as const,
        });
      }

      const activeReturns = await tx
        .select({ id: returns.id, number: returns.number })
        .from(returns)
        .where(
          and(
            eq(returns.originalInvoiceId, id),
            eq(returns.tenantId, ctx.tenantId),
            eq(returns.status, "active"),
          ),
        );
      if (activeReturns.length > 0) {
        const nums = activeReturns.map((r) => r.number).join("، ");
        throw new BusinessRuleError(
          `لا يمكن إلغاء الفاتورة ${inv.number} لوجود مرتجعات نشطة (${nums}). ألغِ المرتجعات أولاً ثم أعد المحاولة.`,
        );
      }

      const ilines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
      // REPAIR-012: take every roll lock up front in ascending id order (the
      // per-line FOR UPDATE below then re-locks rows already held), so cancel
      // cannot deadlock against create/update/return which lock the same way.
      {
        const { lockRollsOrdered } = await import("./rollLocking.js");
        await lockRollsOrdered(
          tx,
          ctx.tenantId,
          ilines.map((l) => l.rollId).filter((x): x is string => Boolean(x)),
          { skipMissing: true },
        );
      }

      // Cancelling a sale also reverses its linked receipts — including any
      // overpaid excess that became customer credit. Snapshot the customer's
      // position so the cancel is refused if that credit was already spent.
      const creditBefore =
        inv.type === "sale"
          ? (await customerCreditPosition(tx, ctx.tenantId, inv.partyId, inv.currency)).unattached
          : null;

      // Release stock for sale invoices (restore what was deducted).
      // Reverse entry invoices (subtract what was added at create time).
      if (inv.type === "sale") {
        for (const l of ilines) {
          const [r] = await tx
            .select({ remainingKg: rolls.remainingKg, remainingPieces: rolls.remainingPieces })
            .from(rolls)
            .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          if (r) {
            const newKg = Number(r.remainingKg) + Number(l.quantityKg);
            const newPieces = Number(r.remainingPieces) + Number(l.pieces ?? 1);
            await tx
              .update(rolls)
              .set({
                remainingKg: String(newKg),
                remainingPieces: newPieces,
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
                description: `إلغاء فاتورة بيع ${inv.number} (استعادة المخزون)`,
              },
              ctx,
            );
          }
        }
      } else {
        // Entry (purchase) cancel reverses stock that was added at create time.
        // NEVER clamp with Math.max(0,…): if any of the entered quantity has
        // already been consumed (sale, print-send, etc.), cancelling would
        // silently wipe remaining stock while leaving downstream documents
        // active — inventory/COGS corruption. Fail closed unless the full
        // line quantity is still on the roll.
        for (const l of ilines) {
          const [r] = await tx
            .select({
              remainingKg: rolls.remainingKg,
              remainingPieces: rolls.remainingPieces,
              rollNo: rolls.rollNo,
            })
            .from(rolls)
            .where(and(eq(rolls.id, l.rollId), eq(rolls.tenantId, ctx.tenantId)))
            .for("update")
            .limit(1);
          if (r) {
            const lineKg = Number(l.quantityKg);
            const linePieces = Number(l.pieces ?? 1);
            const availableKg = Number(r.remainingKg);
            const availablePieces = Number(r.remainingPieces);
            if (availableKg + 1e-9 < lineKg || availablePieces < linePieces) {
              throw new BusinessRuleError(
                `لا يمكن إلغاء فاتورة الشراء ${inv.number}: اللفافة ${r.rollNo} لم تعد تحتوي كامل كمية الدخول (متاح ${availableKg} كغ / ${availablePieces} ثوب من أصل ${lineKg} كغ / ${linePieces} ثوب). ألغِ فواتير البيع أو الحركات اللاحقة على هذه اللفافة أولاً ثم أعد المحاولة.`,
              );
            }
            const newKg = Math.round((availableKg - lineKg) * 100) / 100;
            const newPieces = availablePieces - linePieces;
            await tx
              .update(rolls)
              .set({
                remainingKg: String(newKg),
                remainingPieces: newPieces,
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
                quantityKg: lineKg,
                balanceAfterKg: newKg,
                referenceType: "purchase_invoice_cancel",
                referenceId: inv.id,
                referenceNumber: inv.number,
                movementDate: inv.date,
                description: `إلغاء فاتورة شراء ${inv.number} (عكس المخزون)`,
              },
              ctx,
            );
          }
        }
      }

      // Cancel linked receipt/payment vouchers (from cash/on-account sales or
      // entry-invoice supplier payments) and reverse their ledger rows atomically.
      const linkedVouchers = await tx
        .select({ id: vouchers.id, kind: vouchers.kind })
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
        // Reverse ledger entries for both receipt_in (sale) and payment_out (entry)
        const receiptVoucherIds = linkedVouchers
          .filter((v) => v.kind === "receipt")
          .map((v) => v.id);
        const paymentVoucherIds = linkedVouchers
          .filter((v) => v.kind === "payment")
          .map((v) => v.id);
        if (receiptVoucherIds.length > 0) {
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
                inArray(ledgerEntries.referenceId, receiptVoucherIds),
                eq(ledgerEntries.status, "active"),
              ),
            );
        }
        if (paymentVoucherIds.length > 0) {
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
                eq(ledgerEntries.referenceType, "payment_out"),
                inArray(ledgerEntries.referenceId, paymentVoucherIds),
                eq(ledgerEntries.status, "active"),
              ),
            );
        }
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

      if (creditBefore !== null) {
        const after = await customerCreditPosition(tx, ctx.tenantId, inv.partyId, inv.currency);
        await assertCreditNotOverdrawn(
          tx,
          ctx.tenantId,
          inv.partyId,
          inv.currency,
          creditBefore,
          after.unattached,
        );
      }

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
      reference: row.reference ?? row.number,
      date: row.date,
      partyId: row.partyId,
      partyType: row.partyType as InvoiceData["partyType"],
      currency: row.currency,
      exchangeRate: row.exchangeRate ?? undefined,
      baseTotal: row.baseTotal ?? undefined,
      subtotal: row.subtotal,
      discount: row.discount,
      tax: row.tax,
      shipping: row.shipping,
      total: row.total,
      paid: row.paid ?? 0,
      creditApplied: row.creditApplied ?? 0,
      amountDue: Number(row.total) - Number(row.paid ?? 0),
      paymentMethod: row.paymentMethod as InvoiceData["paymentMethod"],
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
        costPerKg: l.costPerKg != null ? Number(l.costPerKg) : null,
        note: n(l.note),
      })),
    };
  }
}
