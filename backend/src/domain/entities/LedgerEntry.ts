import type { UUID, EntityStatus, LedgerType, CashImpact } from "../types/index.js";

export interface LedgerEntryData {
  id: UUID;
  tenantId: UUID;
  partyId: UUID | null;
  date: string;
  type: LedgerType;
  debit: number;
  credit: number;
  currency: string;
  cashImpact: CashImpact;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  description?: string;
  status: EntityStatus;
  createdAt: string;
  createdBy?: UUID;
  cancelledAt?: string;
  cancelledBy?: UUID;
  cancellationReferenceId?: UUID;
}

export class LedgerEntry {
  private constructor(private readonly data: LedgerEntryData) {}

  static create(input: CreateLedgerEntryInput): LedgerEntry {
    const hasDebit = (input.debit ?? 0) > 0;
    const hasCredit = (input.credit ?? 0) > 0;
    if (hasDebit && hasCredit) throw new Error("Entry cannot have both debit and credit");
    if (!hasDebit && !hasCredit) throw new Error("Entry must have debit or credit");

    return new LedgerEntry({
      id: "" as UUID,
      tenantId: "" as UUID,
      partyId: input.partyId ?? null,
      date: input.date,
      type: input.type,
      debit: input.debit ?? 0,
      credit: input.credit ?? 0,
      currency: input.currency ?? "SYP",
      cashImpact: input.cashImpact ?? "none",
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      referenceNumber: input.referenceNumber,
      description: input.description,
      status: "active" as EntityStatus,
      createdAt: "",
      createdBy: undefined,
      cancelledAt: undefined,
      cancelledBy: undefined,
      cancellationReferenceId: undefined,
    });
  }

  static reconstitute(data: LedgerEntryData): LedgerEntry {
    return new LedgerEntry(data);
  }

  cancel(cancelledBy: UUID, cancellationReferenceId?: UUID): void {
    if (this.data.status === "cancelled") return;
    this.data.status = "cancelled";
    this.data.cancelledAt = new Date().toISOString();
    this.data.cancelledBy = cancelledBy;
    if (cancellationReferenceId) this.data.cancellationReferenceId = cancellationReferenceId;
  }

  toData(): LedgerEntryData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get partyId(): UUID | null {
    return this.data.partyId;
  }
  get debit(): number {
    return this.data.debit;
  }
  get credit(): number {
    return this.data.credit;
  }
  get status(): EntityStatus {
    return this.data.status;
  }
  get type(): LedgerType {
    return this.data.type;
  }
  get cashImpact(): CashImpact {
    return this.data.cashImpact;
  }
}

export interface CreateLedgerEntryInput {
  partyId?: UUID | null;
  date: string;
  type: LedgerType;
  debit?: number;
  credit?: number;
  currency?: string;
  cashImpact?: CashImpact;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  description?: string;
}

export interface PartyBalance {
  partyId: UUID;
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

export function computeReversal(entry: LedgerEntryData): {
  debit: number;
  credit: number;
  cashImpact: string;
} {
  return {
    debit: entry.credit,
    credit: entry.debit,
    cashImpact: entry.cashImpact === "in" ? "out" : entry.cashImpact === "out" ? "in" : "none",
  };
}
