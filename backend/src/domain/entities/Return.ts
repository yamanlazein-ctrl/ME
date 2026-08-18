import type { UUID, EntityStatus, ReturnKind } from "../types/index.js";

export interface ReturnLineData {
  id: UUID;
  returnId: UUID;
  rollId: UUID;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
}

export interface ReturnData {
  id: UUID;
  tenantId: UUID;
  number: string;
  kind: ReturnKind;
  date: string;
  partyId: UUID;
  originalInvoiceId?: UUID;
  reason: string;
  currency: string;
  notesPrint?: string;
  notesInternal?: string;
  status: EntityStatus;
  lines: ReturnLineData[];
  version: number;
  createdAt: string;
  createdBy?: UUID;
  cancelledAt?: string;
  cancelledBy?: UUID;
}

export class ReturnDoc {
  private constructor(private readonly data: ReturnData) {}

  static create(input: CreateReturnInput, number: string): ReturnDoc {
    return new ReturnDoc({
      id: "" as UUID,
      tenantId: "" as UUID,
      number,
      kind: input.kind,
      date: input.date,
      partyId: input.partyId,
      originalInvoiceId: input.originalInvoiceId,
      reason: input.reason,
      currency: input.currency ?? "SYP",
      notesPrint: input.notesPrint?.trim(),
      notesInternal: input.notesInternal?.trim(),
      status: "active" as EntityStatus,
      lines: input.lines.map((l) => ({
        id: "" as UUID,
        returnId: "" as UUID,
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        pieces: l.pieces ?? 1,
        pricePerKg: l.pricePerKg,
      })),
      version: 1,
      createdAt: "",
      createdBy: undefined,
      cancelledAt: undefined,
      cancelledBy: undefined,
    });
  }

  static reconstitute(data: ReturnData): ReturnDoc {
    return new ReturnDoc(data);
  }

  cancel(cancelledBy: UUID): void {
    if (this.data.status === "cancelled") throw new Error("Return already cancelled");
    this.data.status = "cancelled";
    this.data.cancelledAt = new Date().toISOString();
    this.data.cancelledBy = cancelledBy;
    this.data.version++;
  }

  get amount(): number {
    return this.data.lines.reduce((s, l) => s + Math.round(l.quantityKg * l.pricePerKg), 0);
  }

  toData(): ReturnData {
    return { ...this.data };
  }
  get id(): UUID {
    return this.data.id;
  }
  get kind(): ReturnKind {
    return this.data.kind;
  }
  get status(): EntityStatus {
    return this.data.status;
  }
  get version(): number {
    return this.data.version;
  }
  get isCancelled(): boolean {
    return this.data.status === "cancelled";
  }
  get lines(): ReturnLineData[] {
    return this.data.lines;
  }
  get originalInvoiceId(): UUID | undefined {
    return this.data.originalInvoiceId;
  }
}

export interface CreateReturnLineInput {
  rollId: UUID;
  quantityKg: number;
  pieces?: number;
  pricePerKg: number;
}

export interface CreateReturnInput {
  kind: ReturnKind;
  date: string;
  partyId: UUID;
  originalInvoiceId?: UUID;
  reason: string;
  currency?: string;
  notesPrint?: string;
  notesInternal?: string;
  lines: CreateReturnLineInput[];
}
