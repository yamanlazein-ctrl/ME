import { eq, ne, and, desc, ilike, or, sql, inArray, notInArray, getTableColumns } from "drizzle-orm";
import { afterCursor, cursorColumns, decodeCursor, keysetOrder, nextCursorOf, type KeysetSpec } from "./keysetPage.js";
import { likeContains } from "../utils/likeEscape.js";
import type { DB } from "../orm/drizzle.js";
import { pgModule } from "../orm/pgLazy.js";
import type { MergePartiesResult } from "../../application/use-cases/parties/mergePartiesUseCase.js";
import { BusinessRuleError } from "../../domain/errors/index.js";
import type {
  IPartyRepository,
  PartyFilter,
  CreatePartyData,
  PartyOpeningData,
} from "../../application/ports/IPartyRepository.js";
import { parties } from "../orm/schemas/party.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { returns } from "../orm/schemas/return.table.js";
import { orders } from "../orm/schemas/order.table.js";
import { Party, type PartyData, type PartyListStats } from "../../domain/entities/Party.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
import {
  aggregatePartyListStats,
  applyLedgerRemainingToPartyStats,
} from "./partyListStatsAggregation.js";

import { localToday } from "../utils/localDate.js";
import { assertYearOpen } from "./dayLockHelper.js";
import { auditLogs } from "../orm/schemas/audit-log.table.js";
/**
 * The balanced opening journal of a party: customer positive = Dr (AR),
 * supplier positive = Cr (AP), mirrored by an equity leg (Σdebit = Σcredit).
 * One source for the local create AND the sync replay on other devices —
 * the replay used to insert the party with no opening journal, so every
 * other device showed the customer's balance without its opening amount.
 */
export function openingJournalRows(input: {
  tenantId: string;
  partyId: string;
  kind: string;
  openingBalance: number;
  currency: string;
  code: string | null;
  date: string;
  /** Optional operator note, appended to the party leg's description. */
  note?: string | null;
  userId: string;
}) {
  const absBal = Math.abs(input.openingBalance);
  const isPositive = input.openingBalance > 0;
  const isSupplier = input.kind === "supplier";
  const partyDebit = isSupplier ? (isPositive ? 0 : absBal) : isPositive ? absBal : 0;
  const partyCredit = isSupplier ? (isPositive ? absBal : 0) : isPositive ? 0 : absBal;
  return [
    {
      tenantId: input.tenantId,
      partyId: input.partyId,
      date: input.date,
      type: "opening" as const,
      debit: partyDebit,
      credit: partyCredit,
      currency: input.currency,
      cashImpact: "none" as const,
      referenceType: "opening",
      referenceId: input.partyId,
      referenceNumber: input.code,
      description: input.note ? `الرصيد الافتتاحي — ${input.note}` : "الرصيد الافتتاحي",
      createdBy: input.userId,
    },
    {
      tenantId: input.tenantId,
      partyId: null,
      date: input.date,
      type: "opening_equity" as const,
      debit: partyCredit,
      credit: partyDebit,
      currency: input.currency,
      cashImpact: "none" as const,
      referenceType: "opening",
      referenceId: input.partyId,
      referenceNumber: input.code,
      description: "رأس مال / حقوق ملكية (مقابل الرصيد الافتتاحي)",
      createdBy: input.userId,
    },
  ];
}

export class PostgresPartyRepository implements IPartyRepository {
  constructor(private readonly db: DB) {}

  /**
   * Merge duplicate parties (moved verbatim from mergePartiesUseCase, S1): moves invoices,
   * vouchers, returns and ledger party_id to the survivor and soft-cancels the source,
   * in one transaction with the controlled ledger party remap enabled.
   */
  async mergeInto(survivorId: string, sourceId: string, ctx: TenantContext): Promise<MergePartiesResult> {
    return this.db.transaction(async (tx) => {
      await (await pgModule()).allowLedgerPartyRemap(tx);

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


  async findById(id: string, ctx: TenantContext): Promise<PartyData | null> {
    const rows = await this.db
      .select()
      .from(parties)
      .where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId)))
      .limit(1);

    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async findByCode(code: string, ctx: TenantContext): Promise<PartyData | null> {
    const rows = await this.db
      .select()
      .from(parties)
      .where(and(eq(parties.code, code), eq(parties.tenantId, ctx.tenantId)))
      .limit(1);

    if (rows.length === 0) return null;
    return this.toDomain(rows[0]);
  }

  async list(filter: PartyFilter, ctx: TenantContext): Promise<PaginatedResult<PartyData>> {
    const conditions = [eq(parties.tenantId, ctx.tenantId)];
    if (filter.kind) conditions.push(eq(parties.kind, filter.kind));
    // D-4 / FR-017: cancelled parties are hidden from operational lists,
    // including the default "all" view. They stay stored and reachable by id
    // and through an explicit `status: "cancelled"` filter (audit/history).
    if (filter.status) conditions.push(eq(parties.status, filter.status));
    else conditions.push(ne(parties.status, "cancelled"));
    if (filter.search) {
      const search = likeContains(filter.search);
      conditions.push(or(ilike(parties.name, search), ilike(parties.code!, search))!);
    }
    const where = and(...conditions);

    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;
    // Keyset mode for "load every row" callers: seek after the cursor instead
    // of OFFSET (constant cost per page, strict total order). keysetPage.ts.
    const keyset: KeysetSpec = { createdAt: parties.createdAt, id: parties.id };
    const cursor = true ? decodeCursor(filter.cursor) : null;
    const pageWhere = cursor ? and(where, afterCursor(keyset, cursor)) : where;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select({ ...getTableColumns(parties), ...cursorColumns(keyset) })
        .from(parties)
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
            .from(parties)
            .where(where),
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    const domains = dataRows.map((r) => this.toDomain(r));
    // Server-side aggregation for the list view (قائمة العملاء/الموردين): one
    // GROUP BY per figure instead of shipping the tenant's invoices/vouchers to
    // the client. Only computed for kind-scoped lists (the consumer always asks
    // per kind); mixed `/parties` lists stay stats-free.
    if (filter.kind && domains.length > 0) {
      const statsMap = await this.computeListStats(
        domains.map((d) => d.id),
        filter.kind,
        ctx.tenantId,
      );
      for (const d of domains) {
        d.stats = statsMap.get(d.id) ?? {
          invoicesCount: 0,
          totalAmount: 0,
          totalPaid: 0,
          remaining: 0,
        };
      }
    }
    const nextCursor = nextCursorOf(dataRows as unknown as Array<Record<string, unknown>>, limit);
    return {
      data: domains,
      meta: {
        total,
        page,
        limit,
        // Without a cursor the COUNT decides; a last page hands out no cursor.
        nextCursor: cursor || offset + limit < total ? nextCursor : null,
        hasNext: cursor ? nextCursor !== null : offset + limit < total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Compute per-party list stats from invoices.
   *
   * Scalars (`totalAmount` / `totalPaid` / `remaining`) stay on the party's
   * default currency so credit-limit UI stays single-currency. `byCurrency`
   * exposes every invoice currency so list/details can show SYP and USD
   * outstanding separately (never blended).
   */
  private async computeListStats(
    partyIds: string[],
    kind: "customer" | "supplier",
    tenantId: string,
  ): Promise<Map<string, PartyListStats>> {
    const invoiceType = kind === "supplier" ? "entry" : "sale";

    const invRows = await this.db
      .select({
        partyId: invoices.partyId,
        partyCurrency: parties.currency,
        currency: invoices.currency,
        cnt: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${invoices.total}), 0)::text`,
        paid: sql<string>`coalesce(sum(${invoices.paid}), 0)::text`,
        lastDate: sql<string>`max(${invoices.date}::text)`,
      })
      .from(invoices)
      .innerJoin(parties, and(eq(parties.id, invoices.partyId), eq(parties.tenantId, tenantId)))
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.type, invoiceType),
          eq(invoices.status, "active"),
          inArray(invoices.partyId, partyIds),
        ),
      )
      .groupBy(invoices.partyId, parties.currency, invoices.currency);

    // The aggregation itself (default-currency scalars vs. currency-summed
    // count vs. byCurrency breakdown) lives in a pure, DB-free function —
    // see partyListStatsAggregation.ts — so it can be unit-tested directly
    // (F09 regression coverage) without a live database.
    const stats = aggregatePartyListStats(
      invRows.map((r) => ({
        partyId: r.partyId,
        partyCurrency: r.partyCurrency,
        currency: r.currency,
        cnt: Number(r.cnt),
        total: Number(r.total),
        paid: Number(r.paid),
        lastDate: r.lastDate,
      })),
    );

    const ledgerRows = await this.db
      .select({
        partyId: ledgerEntries.partyId,
        currency: ledgerEntries.currency,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)::text`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.status, "active"),
          inArray(ledgerEntries.partyId, partyIds),
        ),
      )
      .groupBy(ledgerEntries.partyId, ledgerEntries.currency);

    return applyLedgerRemainingToPartyStats(
      stats,
      ledgerRows
        .filter((r) => r.partyId)
        .map((r) => ({
          partyId: r.partyId as string,
          currency: r.currency,
          debit: Number(r.debit),
          credit: Number(r.credit),
        })),
      kind,
    );
  }

  async create(data: CreatePartyData, ctx: TenantContext): Promise<PartyData> {
    const openingBalance = data.openingBalance ?? 0;
    const currency = data.currency ?? "SYP";
    const openingDate = data.openingDate ?? localToday();
    const openingNote = data.openingNote?.trim() || null;

    return this.db.transaction(async (tx) => {
      // H-NEW: explicit client codes pass through; auto-codes allocate inside
      // this transaction so an insert/ledger failure rolls back the counter.
      //
      // Multi-device fix (2026-09-10): the code is allocated from this device's
      // reserved block when one exists. Previously the call passed no
      // `syncDeviceId`, so every node drew from its own local
      // `document_sequences` and two offline devices both produced
      // `CUS-<year>-0001` — the second one's hub insert then died on
      // `parties (tenant_id, code)` and the unit never materialized.
      // `allowGlobalFallback` keeps a never-provisioned device working: it
      // degrades to the old shared-sequence behaviour (logged) instead of
      // refusing to save a customer.
      const code =
        data.code?.trim() ||
        (await allocateDocumentNumber(
          tx,
          data.kind === "supplier" ? "supplier" : "customer",
          ctx.tenantId,
          {
            syncDeviceId: ctx.syncDeviceId,
            allowGlobalFallback: true,
          },
        ));

      const [row] = await tx
        .insert(parties)
        .values({
          tenantId: ctx.tenantId,
          kind: data.kind,
          code,
          name: data.name,
          companyName: data.companyName,
          commercialReg: data.commercialReg,
          category: data.category,
          salesRep: data.salesRep,
          phone: data.phone,
          mobile: data.mobile,
          whatsapp: data.whatsapp,
          altPhone: data.altPhone,
          email: data.email,
          website: data.website,
          address: data.address,
          city: data.city,
          country: data.country,
          taxNumber: data.taxNumber,
          openingBalance,
          openingDate: openingBalance !== 0 ? openingDate : (data.openingDate ?? null),
          openingNote,
          openingCurrency: data.openingCurrency ?? null,
          creditLimit: data.creditLimit ?? 0,
          currency,
          paymentTerms: data.paymentTerms,
          paymentMethod: data.paymentMethod,
          defaultDiscount: data.defaultDiscount ?? 0,
          vat: String(data.vat ?? 0),
          notes: data.notes,
          createdBy: ctx.userId,
        })
        .returning();

      // Record the opening balance as a ledger entry so it is reflected in the
      // party statement and balance. Standard double-entry (Dr inventory /
      // Cr AP for supplier-side docs — see PostgresInvoiceRepository,
      // PostgresStatementRepository): customer positive = Dr (AR), supplier
      // positive = Cr (AP). The equity leg mirrors the party leg so every
      // opening journal is balanced (Σdebit = Σcredit).
      if (openingBalance !== 0) {
        await assertYearOpen(tx, ctx.tenantId, openingDate);
        await tx.insert(ledgerEntries).values(
          openingJournalRows({
            tenantId: ctx.tenantId,
            partyId: row.id,
            kind: data.kind,
            openingBalance,
            currency: data.openingCurrency ?? currency,
            code,
            date: openingDate,
            note: openingNote,
            userId: ctx.userId,
          }),
        );
      }

      return this.toDomain(row);
    });
  }

  async update(id: string, data: Partial<CreatePartyData>, ctx: TenantContext, expectedVersion: number): Promise<PartyData> {
    // TX6 fix: openingBalance cannot be edited after creation. The opening
    // ledger row is written exactly once on create (Phase 0). Allowing a
    // silent change here would leave the ledger and the parties.outstanding
    // column out of sync. Refuse explicitly so the caller knows to recreate.
    if (data.openingBalance !== undefined) {
      throw new Error("الرصيد الافتتاحي يُعدَّل من قسم «الرصيد السابق» فقط (PUT …/:id/opening)");
    }
    const values: Record<string, unknown> = {};
    if (data.name !== undefined) values.name = data.name;
    if (data.code !== undefined) values.code = data.code ?? null;
    if (data.companyName !== undefined) values.companyName = data.companyName ?? null;
    if (data.commercialReg !== undefined) values.commercialReg = data.commercialReg ?? null;
    if (data.category !== undefined) values.category = data.category ?? null;
    if (data.salesRep !== undefined) values.salesRep = data.salesRep ?? null;
    if (data.phone !== undefined) values.phone = data.phone ?? null;
    if (data.mobile !== undefined) values.mobile = data.mobile ?? null;
    if (data.whatsapp !== undefined) values.whatsapp = data.whatsapp ?? null;
    if (data.altPhone !== undefined) values.altPhone = data.altPhone ?? null;
    if (data.email !== undefined) values.email = data.email ?? null;
    if (data.website !== undefined) values.website = data.website ?? null;
    if (data.address !== undefined) values.address = data.address ?? null;
    if (data.city !== undefined) values.city = data.city ?? null;
    if (data.country !== undefined) values.country = data.country ?? null;
    if (data.taxNumber !== undefined) values.taxNumber = data.taxNumber ?? null;
    if (data.currency !== undefined) values.currency = data.currency;
    if (data.paymentTerms !== undefined) values.paymentTerms = data.paymentTerms ?? null;
    if (data.paymentMethod !== undefined) values.paymentMethod = data.paymentMethod ?? null;
    if (data.creditLimit !== undefined) values.creditLimit = data.creditLimit;
    if (data.defaultDiscount !== undefined) values.defaultDiscount = data.defaultDiscount;
    if (data.vat !== undefined) values.vat = data.vat;
    if (data.notes !== undefined) values.notes = data.notes ?? null;
    if (data.status !== undefined && data.status !== "cancelled") values.status = data.status;
    if (Object.keys(values).length === 0) {
      const existing = await this.findById(id, ctx);
      if (!existing) throw new Error("Party not found");
      return existing;
    }
    values.updatedAt = new Date();
    values.version = sql`${parties.version} + 1`;

    // P0-001: atomic version enforcement — WHERE includes expectedVersion
    const whereConditions = [eq(parties.id, id), eq(parties.tenantId, ctx.tenantId), eq(parties.version, expectedVersion)];
    const [row] = await this.db
      .update(parties)
      .set(values)
      .where(and(...whereConditions))
      .returning();

    if (!row) {
      // P0-001: distinguish "not found" from "stale version"
      const existing = await this.db.select({ version: parties.version }).from(parties).where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId))).limit(1);
      if (existing.length > 0) {
        throw Object.assign(new Error(`Stale version: expected ${expectedVersion}, current ${existing[0].version}`), { code: "STALE_VERSION" as const });
      }
      throw new Error("Party not found");
    }
    return this.toDomain(row);
  }

  async setOpening(id: string, data: PartyOpeningData, ctx: TenantContext, expectedVersion: number): Promise<PartyData> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId)))
        .limit(1);
      if (!before) throw new Error("الطرف غير موجود");
      // Version claim first (P0-001): a concurrent edit loses here, before any ledger write.
      const [row] = await tx
        .update(parties)
        .set({
          openingBalance: data.openingBalance,
          openingCurrency: data.currency,
          openingDate: data.date,
          openingNote: data.note ?? null,
          updatedAt: new Date(),
          version: sql`${parties.version} + 1`,
        })
        .where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId), eq(parties.version, expectedVersion)))
        .returning();
      if (!row) {
        throw Object.assign(new Error(`Stale version: expected ${expectedVersion}, current ${before.version}`), {
          code: "STALE_VERSION" as const,
        });
      }

      const old = await tx
        .select({ id: ledgerEntries.id, date: ledgerEntries.date })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, ctx.tenantId),
            eq(ledgerEntries.referenceType, "opening"),
            eq(ledgerEntries.referenceId, id),
            eq(ledgerEntries.status, "active"),
          ),
        );
      // Neither the journal being cancelled nor the new one may sit in a closed year.
      for (const d of new Set([...old.map((r) => String(r.date)), data.date])) {
        await assertYearOpen(tx, ctx.tenantId, d);
      }
      // Cancel, never delete: the append-only trigger allows only status → cancelled, and the
      // statement keeps showing the old journal as cancelled.
      if (old.length > 0) {
        await tx
          .update(ledgerEntries)
          .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: ctx.userId })
          .where(and(eq(ledgerEntries.tenantId, ctx.tenantId), inArray(ledgerEntries.id, old.map((r) => r.id))));
      }
      if (data.openingBalance !== 0) {
        await tx.insert(ledgerEntries).values(
          openingJournalRows({
            tenantId: ctx.tenantId,
            partyId: id,
            kind: before.kind,
            openingBalance: data.openingBalance,
            currency: data.currency,
            code: before.code ?? null,
            date: data.date,
            note: data.note,
            userId: ctx.userId,
          }),
        );
      }
      await tx.insert(auditLogs).values({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorName: ctx.userName,
        module: "parties",
        action: "set_opening",
        entityType: "party",
        entityId: id,
        detail: "تعديل الرصيد الافتتاحي",
        beforeSnapshot: {
          openingBalance: Number(before.openingBalance ?? 0),
          currency: before.openingCurrency ?? before.currency,
          date: before.openingDate ?? null,
          note: before.openingNote ?? null,
        },
        afterSnapshot: {
          openingBalance: data.openingBalance,
          currency: data.currency,
          date: data.date,
          note: data.note ?? null,
        },
      });
      return this.toDomain(row);
    });
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext, expectedVersion: number): Promise<PartyData> {
    // Security guard: refuse to cancel a party that still has active financial
    // documents (invoices or vouchers) linked to it. The party is soft-deleted
    // (status → cancelled), but the FK references remain valid, so this is a
    // business rule rather than a DB constraint — enforce it explicitly.
    const [partyRow] = await this.db
      .select({ kind: parties.kind })
      .from(parties)
      .where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId)))
      .limit(1);

    if (!partyRow) throw new Error("الطرف غير موجود");
    const kindLabel = partyRow.kind === "supplier" ? "المورد" : "العميل";

    const [invCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.partyId, id),
          eq(invoices.tenantId, ctx.tenantId),
          eq(invoices.status, "active"),
        ),
      );
    if (Number(invCount?.count ?? 0) > 0) {
      const sample = await this.db
        .select({ number: invoices.number, type: invoices.type })
        .from(invoices)
        .where(
          and(
            eq(invoices.partyId, id),
            eq(invoices.tenantId, ctx.tenantId),
            eq(invoices.status, "active"),
          ),
        )
        .limit(8);
      const nums = sample.map((r) => r.number).join("، ");
      throw new Error(
        `لا يمكن حذف ${kindLabel} لوجود فواتير مرتبطة به (${nums}${Number(invCount.count) > 8 ? "…" : ""}). استخدم شاشة الحذف لعرض التفاصيل والتأكيد.`,
      );
    }

    const [vchCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.partyId, id),
          eq(vouchers.tenantId, ctx.tenantId),
          eq(vouchers.status, "active"),
        ),
      );
    if (Number(vchCount?.count ?? 0) > 0) {
      const sample = await this.db
        .select({ number: vouchers.number })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.partyId, id),
            eq(vouchers.tenantId, ctx.tenantId),
            eq(vouchers.status, "active"),
          ),
        )
        .limit(8);
      const nums = sample.map((r) => r.number).join("، ");
      throw new Error(
        `لا يمكن حذف ${kindLabel} لوجود سندات قبض/صرف مرتبطة به (${nums}${Number(vchCount.count) > 8 ? "…" : ""}). استخدم شاشة الحذف لعرض التفاصيل والتأكيد.`,
      );
    }

    // AUDIT-F3: the guard above only knew about invoices and vouchers, while the
    // impact sheet also reports RETURNS. A party holding an active return but no
    // invoice/voucher therefore passed this guard and got soft-cancelled, leaving
    // a live return pointing at a cancelled party (verified against PostgreSQL).
    // The last line of defence must match the sheet the user was shown.
    const [retCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(returns)
      .where(
        and(
          eq(returns.partyId, id),
          eq(returns.tenantId, ctx.tenantId),
          eq(returns.status, "active"),
        ),
      );
    if (Number(retCount?.count ?? 0) > 0) {
      const sample = await this.db
        .select({ number: returns.number })
        .from(returns)
        .where(
          and(
            eq(returns.partyId, id),
            eq(returns.tenantId, ctx.tenantId),
            eq(returns.status, "active"),
          ),
        )
        .limit(8);
      const nums = sample.map((r) => r.number).join("، ");
      throw new Error(
        `لا يمكن حذف ${kindLabel} لوجود مرتجعات مرتبطة (${nums}${
          Number(retCount.count) > 8 ? "…" : ""
        }). ألغِ المرتجعات أولاً أو استخدم شاشة الحذف.`,
      );
    }

    // AUDIT-F1: only OPEN orders block the party; a fulfilled/cancelled order is
    // history (same rule the impact sheet now applies).
    const [ordCount] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(orders)
      .where(
        and(
          eq(orders.customerId, id),
          eq(orders.tenantId, ctx.tenantId),
          notInArray(orders.status, ["fulfilled", "cancelled"]),
        ),
      );
    if (Number(ordCount?.count ?? 0) > 0) {
      const sample = await this.db
        .select({ code: orders.code })
        .from(orders)
        .where(
          and(
            eq(orders.customerId, id),
            eq(orders.tenantId, ctx.tenantId),
            notInArray(orders.status, ["fulfilled", "cancelled"]),
          ),
        )
        .limit(8);
      const nums = sample.map((r) => r.code).join("، ");
      throw new Error(
        `لا يمكن حذف ${kindLabel} لوجود طلبيات مفتوحة (${nums}${
          Number(ordCount.count) > 8 ? "…" : ""
        }). أغلق أو احذف الطلبيات أولاً.`,
      );
    }

    // P0-001: atomic version enforcement — WHERE includes expectedVersion
    const whereConditions = [eq(parties.id, id), eq(parties.tenantId, ctx.tenantId), eq(parties.status, "active"), eq(parties.version, expectedVersion)];
    const [row] = await this.db
      .update(parties)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy,
        updatedAt: new Date(),
        version: sql`${parties.version} + 1`,
      })
      .where(and(...whereConditions))
      .returning();

    if (!row) {
      // P0-001: distinguish "not found" from "stale version"
      const existing = await this.db.select({ version: parties.version }).from(parties).where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId))).limit(1);
      if (existing.length > 0) {
        throw Object.assign(new Error(`Stale version: expected ${expectedVersion}, current ${existing[0].version}`), { code: "STALE_VERSION" as const });
      }
      throw new Error("الطرف غير موجود أو ملغى مسبقاً");
    }
    return this.toDomain(row);
  }

  async alignVersion(id: string, version: number, ctx: TenantContext): Promise<void> {
    await this.db
      .update(parties)
      .set({ version })
      .where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId)));
  }

  private toDomain(row: typeof parties.$inferSelect): PartyData {
    return Party.reconstitute(this.mapRow(row)).toData();
  }

  private mapRow(row: typeof parties.$inferSelect): PartyData {
    const n = (v: string | null) => v ?? undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind as PartyData["kind"],
      code: n(row.code),
      name: row.name,
      companyName: n(row.companyName),
      commercialReg: n(row.commercialReg),
      category: n(row.category),
      salesRep: n(row.salesRep),
      phone: n(row.phone),
      mobile: n(row.mobile),
      whatsapp: n(row.whatsapp),
      altPhone: n(row.altPhone),
      email: n(row.email),
      website: n(row.website),
      address: n(row.address),
      city: n(row.city),
      country: n(row.country),
      taxNumber: n(row.taxNumber),
      openingBalance: row.openingBalance,
      openingDate: n(row.openingDate),
      openingNote: n(row.openingNote),
      openingCurrency: n(row.openingCurrency),
      creditLimit: row.creditLimit ?? 0,
      currency: row.currency,
      paymentTerms: n(row.paymentTerms),
      paymentMethod: n(row.paymentMethod),
      defaultDiscount: Number(row.defaultDiscount ?? 0),
      vat: Number(row.vat ?? 0),
      status: row.status as PartyData["status"],
      notes: n(row.notes),
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
