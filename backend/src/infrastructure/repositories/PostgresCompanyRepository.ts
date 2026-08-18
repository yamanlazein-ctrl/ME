import { eq } from "drizzle-orm";
import { withTenantTx, db as defaultDb, type DB } from "../orm/drizzle.js";
import type { UUID } from "../../domain/types/index.js";
import type {
  ICompanyRepository,
  CompanyProfileRow,
  UpsertCompanyProfileInput,
} from "../../application/ports/ICompanyRepository.js";
import { companyProfiles } from "../orm/schemas/company-profile.table.js";

type Row = typeof companyProfiles.$inferSelect;

function toRow(r: Row): CompanyProfileRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    commercialReg: r.commercialReg,
    taxNumber: r.taxNumber,
    address: r.address,
    city: r.city,
    country: r.country,
    phone: r.phone,
    email: r.email,
    logoPath: r.logoPath,
    currency: r.currency,
    language: r.language,
    fiscalYearStart: r.fiscalYearStart,
    defaultTaxRate: r.defaultTaxRate,
    customization: (r.customization as Record<string, unknown> | null) ?? {},
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class PostgresCompanyRepository implements ICompanyRepository {
  constructor(private readonly db: DB = defaultDb) {}

  async findByTenant(tenantId: UUID): Promise<CompanyProfileRow | null> {
    return withTenantTx(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(companyProfiles)
        .where(eq(companyProfiles.tenantId, tenantId))
        .limit(1);
      return row ? toRow(row) : null;
    });
  }

  async upsert(input: UpsertCompanyProfileInput): Promise<CompanyProfileRow> {
    return withTenantTx(input.tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(companyProfiles)
        .where(eq(companyProfiles.tenantId, input.tenantId))
        .limit(1);

      if (existing) {
        const [row] = await tx
          .update(companyProfiles)
          .set({
            name: input.name,
            commercialReg: input.commercialReg ?? existing.commercialReg,
            taxNumber: input.taxNumber ?? existing.taxNumber,
            address: input.address ?? existing.address,
            city: input.city ?? existing.city,
            country: input.country ?? existing.country,
            phone: input.phone ?? existing.phone,
            email: input.email ?? existing.email,
            currency: input.currency ?? existing.currency,
            language: input.language ?? existing.language,
            fiscalYearStart: input.fiscalYearStart ?? existing.fiscalYearStart,
            defaultTaxRate: input.defaultTaxRate ?? existing.defaultTaxRate,
            customization: input.customization ?? existing.customization,
            updatedAt: new Date(),
          })
          .where(eq(companyProfiles.tenantId, input.tenantId))
          .returning();
        if (!row) throw new Error("COMPANY_UPDATE_FAILED");
        return toRow(row);
      }

      const [row] = await tx
        .insert(companyProfiles)
        .values({
          tenantId: input.tenantId,
          name: input.name,
          commercialReg: input.commercialReg ?? null,
          taxNumber: input.taxNumber ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          country: input.country ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          currency: input.currency ?? "SYP",
          language: input.language ?? "ar",
          fiscalYearStart: input.fiscalYearStart ?? null,
          defaultTaxRate: input.defaultTaxRate ?? "0.0000",
          customization: input.customization ?? {},
        })
        .returning();
      if (!row) throw new Error("COMPANY_INSERT_FAILED");
      return toRow(row);
    });
  }

  async setLogoPath(tenantId: UUID, logoPath: string | null): Promise<void> {
    await withTenantTx(tenantId, async (tx) => {
      await tx
        .update(companyProfiles)
        .set({ logoPath, updatedAt: new Date() })
        .where(eq(companyProfiles.tenantId, tenantId));
    });
  }
}
