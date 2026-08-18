import { LedgerEntry, type LedgerEntryData } from "@/domain/entities/LedgerEntry";
import { Money } from "@/domain/value-objects/Money";
import { TenantContext, UUID } from "@/domain/types";
import type { ILedgerRepository, LedgerFilter } from "@/application/ports/ILedgerRepository";
import type { Currency, PaginatedResult, LedgerType } from "@/domain/types";
import { LedgerApiService } from "@/infrastructure/api";

export class ApiLedgerRepository implements ILedgerRepository {
  constructor(private api: LedgerApiService) {}

  async entries(filter: LedgerFilter, ctx: TenantContext): Promise<PaginatedResult<LedgerEntry>> {
    const res = await this.api.list({ ...filter, types: filter.types as LedgerType[] });
    const data = res.data.map((dto) => LedgerEntry.reconstitute(dto as unknown as LedgerEntryData));
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async write(entry: LedgerEntry, ctx: TenantContext): Promise<LedgerEntry> {
    // The backend writes ledger entries atomically inside the same transaction
    // that creates/updates the business document (invoice, voucher, …). A
    // frontend "write" is therefore a no-op — calling this does not persist
    // anything and must never throw, or the surrounding use case would abort
    // after the document was already created. See PostgresInvoiceRepository /
    // PostgresVoucherRepository for the authoritative writes.
    void ctx;
    return entry;
  }

  async cancelByReference(referenceId: UUID, ctx: TenantContext): Promise<void> {
    throw new Error("Ledger cancellation is performed by domain use cases.");
  }

  async balance(partyId: UUID, currency: string, ctx: TenantContext): Promise<Money> {
    const res = await this.api.balance(partyId, currency);
    return new Money(res.balance, currency as Currency);
  }

  async cashMovementsOn(
    date: string,
    currency: string,
    ctx: TenantContext,
  ): Promise<{ in: number; out: number }> {
    const res = await this.api.cashMovementsOn(date, currency);
    return { in: res.in, out: res.out };
  }
}
