import type { TenantContext, UUID } from "@/domain/types";

export type PrintJobStatus = "sent" | "received";

export interface PrintJobDTO {
  id: UUID;
  tenantId: UUID;
  number: string;
  sentDate: string;
  sourceRollId: UUID;
  sourceFabricId: UUID;
  sourceColorId: UUID;
  sentKg: number;
  pressName: string;
  notes?: string | null;
  status: PrintJobStatus;
  receivedDate?: string | null;
  receivedKg?: number | null;
  printCostPerKg?: number | null;
  currency?: string | null;
  newFabricId?: UUID | null;
  newColorId?: UUID | null;
  newRollId?: UUID | null;
  newName?: string | null;
  newSalePricePerKg?: number | null;
  receiveNotes?: string | null;
}

export interface CreatePrintSendInput {
  date: string;
  sourceRollId: UUID;
  quantityKg: number;
  pieces?: number;
  pressName: string;
  notes?: string;
}

export interface ReceivePrintInput {
  jobId: UUID;
  date: string;
  receivedKg: number;
  printCostPerKg: number;
  currency: string;
  newName: string;
  newCategory?: string;
  newColorName?: string;
  newColorCode?: string;
  newSalePricePerKg?: number;
  notes?: string;
}

export interface IPrintJobRepository {
  findById(id: UUID, ctx: TenantContext): Promise<PrintJobDTO | null>;
  listAll(ctx: TenantContext): Promise<PrintJobDTO[]>;
  listOpen(ctx: TenantContext): Promise<PrintJobDTO[]>;
  createSend(input: CreatePrintSendInput, ctx: TenantContext): Promise<PrintJobDTO>;
  receive(input: ReceivePrintInput, ctx: TenantContext): Promise<PrintJobDTO>;
}
