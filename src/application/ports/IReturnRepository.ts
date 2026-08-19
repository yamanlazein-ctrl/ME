import type { TenantContext, UUID, PaginatedResult } from "@/domain/types";

export type ReturnKind = "entry" | "sale";
export type ReturnReason = "defect" | "wrong_quantity" | "wrong_order" | "other";
export type ReturnStatus = "active" | "cancelled";

export interface ReturnLineDTO {
  id: UUID;
  rollId: UUID;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
}

export interface ReturnDTO {
  id: UUID;
  tenantId: UUID;
  number: string;
  /** Manual/reference number (e.g. "RET-2026-XYZ"). Optional. */
  reference?: string | null;
  kind: ReturnKind;
  date: string;
  partyId: UUID;
  originalInvoiceId?: UUID | null;
  lines: ReturnLineDTO[];
  reason: ReturnReason;
  currency: string;
  notesPrint?: string | null;
  notesInternal?: string | null;
  status: ReturnStatus;
  createdAt: string;
  createdBy: string;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
}

export interface CreateReturnInput {
  kind: ReturnKind;
  date: string;
  partyId: UUID;
  originalInvoiceId?: UUID;
  lines: Omit<ReturnLineDTO, "id">[];
  reason: ReturnReason;
  currency: string;
  notesPrint?: string;
  notesInternal?: string;
}

export interface ReturnFilter {
  kind?: ReturnKind;
  partyId?: UUID;
  status?: ReturnStatus | "all";
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface IReturnRepository {
  findById(id: UUID, ctx: TenantContext): Promise<ReturnDTO | null>;
  list(filter: ReturnFilter, ctx: TenantContext): Promise<PaginatedResult<ReturnDTO>>;
  create(input: CreateReturnInput, ctx: TenantContext): Promise<ReturnDTO>;
  cancel(id: UUID, ctx: TenantContext): Promise<void>;
}
