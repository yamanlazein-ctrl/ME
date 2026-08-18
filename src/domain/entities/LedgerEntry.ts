import { Timestamp, UUID, Currency, Mutable } from "@/domain/types";

/* ────────────────────────────────────────────────────────────────────────
 *  LedgerEntry Entity — append-only, immutable after creation.
 *  Cancellation is a NEW entry or a soft-delete flag; never mutate history.
 * ──────────────────────────────────────────────────────────────────────── */

export interface LedgerEntryData {
  id: UUID;
  tenantId: UUID;
  date: string; // yyyy-mm-dd
  type: string;
  referenceType: string;
  referenceId?: UUID | null;
  referenceNumber?: string | null;
  partyId?: UUID | null;
  partyKind?: "customer" | "supplier" | null;
  debit: number;
  credit: number;
  currency: Currency;
  cashImpact: "in" | "out" | "none";
  description: string;
  notesInternal?: string | null;
  status: "active" | "cancelled";
  createdBy: string;
  createdAt: Timestamp;
  cancelledAt?: Timestamp | null;
  cancelledBy?: string | null;
  invoiceId?: UUID | null;
}

export class LedgerEntry implements LedgerEntryData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly date: string;
  readonly type: string;
  readonly referenceType: string;
  readonly referenceId?: UUID | null;
  readonly referenceNumber?: string | null;
  readonly partyId?: UUID | null;
  readonly partyKind?: "customer" | "supplier" | null;
  readonly debit: number;
  readonly credit: number;
  readonly currency: Currency;
  readonly cashImpact: "in" | "out" | "none";
  readonly description: string;
  readonly notesInternal?: string | null;
  status: "active" | "cancelled";
  readonly createdBy: string;
  readonly createdAt: Timestamp;
  cancelledAt?: Timestamp | null;
  cancelledBy?: string | null;
  readonly invoiceId?: UUID | null;

  private constructor(data: LedgerEntryData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.date = data.date;
    this.type = data.type;
    this.referenceType = data.referenceType;
    this.referenceId = data.referenceId;
    this.referenceNumber = data.referenceNumber;
    this.partyId = data.partyId;
    this.partyKind = data.partyKind;
    this.debit = data.debit;
    this.credit = data.credit;
    this.currency = data.currency;
    this.cashImpact = data.cashImpact;
    this.description = data.description;
    this.notesInternal = data.notesInternal;
    this.status = data.status;
    this.createdBy = data.createdBy;
    this.createdAt = data.createdAt;
    this.cancelledAt = data.cancelledAt;
    this.cancelledBy = data.cancelledBy;
    this.invoiceId = data.invoiceId;
  }

  static create(
    props: Omit<LedgerEntryData, "id" | "status" | "createdAt" | "cancelledAt" | "cancelledBy">,
  ): LedgerEntry {
    return new LedgerEntry({
      ...props,
      id: crypto.randomUUID(),
      status: "active",
      createdAt: new Date().toISOString(),
      cancelledAt: null,
      cancelledBy: null,
    });
  }

  static debit(
    props: Omit<
      LedgerEntryData,
      "id" | "status" | "debit" | "credit" | "createdAt" | "cancelledAt" | "cancelledBy"
    > & {
      amount: number;
    },
  ): LedgerEntry {
    return LedgerEntry.create({ ...props, debit: props.amount, credit: 0 });
  }

  static credit(
    props: Omit<
      LedgerEntryData,
      "id" | "status" | "debit" | "credit" | "createdAt" | "cancelledAt" | "cancelledBy"
    > & {
      amount: number;
    },
  ): LedgerEntry {
    return LedgerEntry.create({ ...props, debit: 0, credit: props.amount });
  }

  isActive(): boolean {
    return this.status === "active";
  }

  isCancelled(): boolean {
    return this.status === "cancelled";
  }

  /** Soft cancellation — records who/when without deleting history. */
  cancel(userName: string): void {
    if (this.isCancelled()) return;
    (this as Mutable<this>).status = "cancelled";
    (this as Mutable<this>).cancelledAt = new Date().toISOString();
    (this as Mutable<this>).cancelledBy = userName;
  }

  /** Reconstitute from persistence (skip validation). */
  static reconstitute(data: LedgerEntryData): LedgerEntry {
    return new LedgerEntry(data);
  }

  /** Net amount (debit − credit) — sign depends on perspective. */
  net(): number {
    return this.debit - this.credit;
  }
}
