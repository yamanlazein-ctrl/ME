import { eq, and, desc, ilike, or, sql } from "drizzle-orm";
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
import { Party, type PartyData } from "../../domain/entities/Party.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { nextDocumentNumber } from "../utils/documentNumbers.js";

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
    return {
      data: dataRows.map((r) => this.toDomain(r)),
      meta: {
        total,
        page,
        limit,
        hasNext: offset + limit < total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async create(data: CreatePartyData, ctx: TenantContext): Promise<PartyData> {
    const code =
      data.code?.trim() ||
      (await nextDocumentNumber(data.kind === "supplier" ? "supplier" : "customer", ctx.tenantId));
    const openingBalance = data.openingBalance ?? 0;
    const currency = data.currency ?? "SYP";

    return this.db.transaction(async (tx) => {
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
      // party statement and balance.
      //
      // Fix C-8 (forensic audit 2026-08-15, verified by hand across 5
      // scenarios before touching this code): this used to flip
      // debit/credit by isCustomer ("customer's opening balance is a
      // DEBIT, a supplier's is a CREDIT"). That was the ONLY sign-flipping
      // write path in the whole ledger — purchase invoices ALWAYS debit
      // the party leg (PostgresInvoiceRepository.ts, same code for sale
      // and purchase), and payment/receipt vouchers ALWAYS credit the
      // party leg (PostgresVoucherRepository.ts, same code for both
      // kinds) — regardless of customer vs supplier. Hand-computed
      // ground truth for a supplier opening at 1000, then +500 purchase,
      // -300 payment, +200 purchase, -100 payment: true running balance
      // is 1000 -> 1500 -> 1200 -> 1400 -> 1300. With the OLD flipped
      // opening convention plus the statement's supplier mult=-1, the
      // system computed 1000 -> 500 -> 800 -> 600 -> 700 — every single
      // post-opening movement ran in the OPPOSITE direction from reality.
      // Debit uniformly = "obligation increases" and credit uniformly =
      // "obligation decreases", for both party kinds — matching what
      // invoices and vouchers already do everywhere else — makes the
      // hand-computed sequence come out exactly right (see
      // PostgresStatementRepository.ts's matching mult fix, and
      // PostgresLedgerRepository.getBalance()/getBalanceByDate(), which
      // already compute plain debit-credit with no kind-based flip at all
      // and therefore become correct for suppliers too once this write
      // path stops flipping).
      if (openingBalance > 0) {
        // C4 fix: double-entry — balance the opening balance with an equity leg.
        await tx.insert(ledgerEntries).values([
          {
            tenantId: ctx.tenantId,
            partyId: row.id,
            date: new Date().toISOString().slice(0, 10),
            type: "opening",
            debit: openingBalance,
            credit: 0,
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
            debit: 0,
            credit: openingBalance,
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
