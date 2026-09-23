import { eq, and, desc, ilike, or, sql, inArray } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type {
  IPartyRepository,
  PartyFilter,
  CreatePartyData,
} from "../../application/ports/IPartyRepository.js";
import { parties } from "../orm/schemas/party.table.js";
import { ledgerEntries } from "../orm/schemas/ledger-entry.table.js";
import { invoices } from "../orm/schemas/invoice.table.js";
import { vouchers } from "../orm/schemas/voucher.table.js";
import { Party, type PartyData, type PartyListStats } from "../../domain/entities/Party.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { allocateDocumentNumber } from "../utils/documentNumbers.js";
import {
  aggregatePartyListStats,
  applyLedgerRemainingToPartyStats,
} from "./partyListStatsAggregation.js";

export class PostgresPartyRepository implements IPartyRepository {
  constructor(private readonly db: DB) {}

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
    if (filter.status) conditions.push(eq(parties.status, filter.status));
    if (filter.search) {
      const search = `%${filter.search}%`;
      conditions.push(or(ilike(parties.name, search), ilike(parties.code!, search))!);
    }
    const where = and(...conditions);

    const page = Math.max(0, filter.page ?? 0);
    const limit = Math.min(1000, Math.max(1, filter.limit ?? 20));
    const offset = page * limit;

    const [dataRows, countRows] = await Promise.all([
      this.db
        .select()
        .from(parties)
        .where(where)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(parties.createdAt)),
      this.db
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
    return {
      data: domains,
      meta: {
        total,
        page,
        limit,
        hasNext: offset + limit < total,
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
        const absBal = Math.abs(openingBalance);
        const isPositive = openingBalance > 0;
        const isSupplier = data.kind === "supplier";
        const partyDebit = isSupplier
          ? isPositive
            ? 0
            : absBal
          : isPositive
            ? absBal
            : 0;
        const partyCredit = isSupplier
          ? isPositive
            ? absBal
            : 0
          : isPositive
            ? 0
            : absBal;
        await tx.insert(ledgerEntries).values([
          {
            tenantId: ctx.tenantId,
            partyId: row.id,
            date: new Date().toISOString().slice(0, 10),
            type: "opening",
            debit: partyDebit,
            credit: partyCredit,
            currency,
            cashImpact: "none",
            referenceType: "opening",
            referenceId: row.id,
            referenceNumber: code,
            description: "الرصيد الافتتاحي",
            createdBy: ctx.userId,
          },
          {
            tenantId: ctx.tenantId,
            partyId: null,
            date: new Date().toISOString().slice(0, 10),
            type: "opening_equity",
            debit: partyCredit,
            credit: partyDebit,
            currency,
            cashImpact: "none",
            referenceType: "opening",
            referenceId: row.id,
            referenceNumber: code,
            description: "رأس مال / حقوق ملكية (مقابل الرصيد الافتتاحي)",
            createdBy: ctx.userId,
          },
        ]);
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
      throw new Error("لا يمكن تعديل الرصيد الافتتاحي بعد الإنشاء — أعد إنشاء الطرف لتغييره");
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
      throw new Error(`لا يمكن حذف ${kindLabel} لوجود فواتير مرتبطة به`);
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
      throw new Error(`لا يمكن حذف ${kindLabel} لوجود سندات قبض/صرف مرتبطة به`);
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
