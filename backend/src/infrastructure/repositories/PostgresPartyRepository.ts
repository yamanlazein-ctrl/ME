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
   * Compute per-party list stats in three indexed GROUP BY queries, each scoped
   * to the party's own currency (matching `buildPartyStats`'s single-currency
   * semantics). `remaining` comes exclusively from the ledger so it always
   * matches the account statement's `finalBalance`.
   */
  private async computeListStats(
    partyIds: string[],
    kind: "customer" | "supplier",
    tenantId: string,
  ): Promise<Map<string, PartyListStats>> {
    const map = new Map<string, PartyListStats>();
    const get = (id: string): PartyListStats => {
      const existing = map.get(id);
      if (existing) return existing;
      const s: PartyListStats = { invoicesCount: 0, totalAmount: 0, totalPaid: 0, remaining: 0 };
      map.set(id, s);
      return s;
    };

    const invoiceType = kind === "supplier" ? "entry" : "sale";
    const voucherKind = kind === "supplier" ? "payment" : "receipt";

    // 1) Invoices: count / total / last date, in the party's currency.
    const invRows = await this.db
      .select({
        partyId: invoices.partyId,
        cnt: sql<number>`count(*)::int`,
        total: sql<string>`coalesce(sum(${invoices.total}), 0)::text`,
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
          eq(invoices.currency, parties.currency),
        ),
      )
      .groupBy(invoices.partyId);

    for (const r of invRows) {
      const s = get(r.partyId);
      s.invoicesCount = Number(r.cnt);
      s.totalAmount = Number(r.total);
      if (r.lastDate) s.lastDate = r.lastDate;
    }

    // 2) Vouchers: total paid, in the party's currency.
    const vchRows = await this.db
      .select({
        partyId: vouchers.partyId,
        total: sql<string>`coalesce(sum(${vouchers.amount}), 0)::text`,
      })
      .from(vouchers)
      .innerJoin(parties, and(eq(parties.id, vouchers.partyId), eq(parties.tenantId, tenantId)))
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.kind, voucherKind),
          eq(vouchers.status, "active"),
          inArray(vouchers.partyId, partyIds),
          eq(vouchers.currency, parties.currency),
        ),
      )
      .groupBy(vouchers.partyId);

    for (const r of vchRows) {
      get(r.partyId).totalPaid = Number(r.total);
    }

    // 3) Ledger balance — the authoritative remaining balance.
    const ledRows = await this.db
      .select({
        partyId: ledgerEntries.partyId,
        debit: sql<string>`coalesce(sum(${ledgerEntries.debit}), 0)::text`,
        credit: sql<string>`coalesce(sum(${ledgerEntries.credit}), 0)::text`,
      })
      .from(ledgerEntries)
      .innerJoin(parties, and(eq(parties.id, ledgerEntries.partyId), eq(parties.tenantId, tenantId)))
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.status, "active"),
          inArray(ledgerEntries.partyId, partyIds),
          eq(ledgerEntries.currency, parties.currency),
        ),
      )
      .groupBy(ledgerEntries.partyId);

    for (const r of ledRows) {
      if (!r.partyId) continue; // ledger_entries.party_id is nullable (cash/non-party rows)
      const d = Number(r.debit);
      const c = Number(r.credit);
      // Standard sign: customer (AR) = debit − credit; supplier (AP) = credit − debit.
      get(r.partyId).remaining = kind === "supplier" ? c - d : d - c;
    }

    return map;
  }

  async create(data: CreatePartyData, ctx: TenantContext): Promise<PartyData> {
    const openingBalance = data.openingBalance ?? 0;
    const currency = data.currency ?? "SYP";

    return this.db.transaction(async (tx) => {
      // H-NEW: explicit client codes pass through; auto-codes allocate inside
      // this transaction so an insert/ledger failure rolls back the counter.
      const code =
        data.code?.trim() ||
        (await allocateDocumentNumber(
          tx,
          data.kind === "supplier" ? "supplier" : "customer",
          ctx.tenantId,
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

  async update(id: string, data: Partial<CreatePartyData>, ctx: TenantContext): Promise<PartyData> {
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
    if (data.phone !== undefined) values.phone = data.phone ?? null;
    if (data.mobile !== undefined) values.mobile = data.mobile ?? null;
    if (data.email !== undefined) values.email = data.email ?? null;
    if (data.address !== undefined) values.address = data.address ?? null;
    if (data.city !== undefined) values.city = data.city ?? null;
    if (data.country !== undefined) values.country = data.country ?? null;
    if (data.notes !== undefined) values.notes = data.notes ?? null;
    if (Object.keys(values).length === 0) {
      const existing = await this.findById(id, ctx);
      if (!existing) throw new Error("Party not found");
      return existing;
    }
    values.updatedAt = new Date();
    values.version = sql`${parties.version} + 1`;

    const [row] = await this.db
      .update(parties)
      .set(values)
      .where(and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId)))
      .returning();

    if (!row) throw new Error("Party not found");
    return this.toDomain(row);
  }

  async cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<PartyData> {
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

    const [row] = await this.db
      .update(parties)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledBy,
        updatedAt: new Date(),
        version: sql`${parties.version} + 1`,
      })
      .where(
        and(eq(parties.id, id), eq(parties.tenantId, ctx.tenantId), eq(parties.status, "active")),
      )
      .returning();

    if (!row) throw new Error("الطرف غير موجود أو ملغى مسبقاً");
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
