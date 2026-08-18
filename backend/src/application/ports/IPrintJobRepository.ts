import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";
import type {
  PrintJobData,
  CreatePrintJobInput,
  ReceivePrintJobInput,
} from "../../domain/entities/PrintJob.js";

export interface IPrintJobRepository {
  findById(id: string, ctx: TenantContext): Promise<PrintJobData | null>;
  list(ctx: TenantContext): Promise<PrintJobData[]>;
  listOpen(ctx: TenantContext): Promise<PrintJobData[]>;
  create(input: CreatePrintJobInput, number: string, ctx: TenantContext): Promise<PrintJobData>;
  receive(input: ReceivePrintJobInput, ctx: TenantContext): Promise<PrintJobData>;
}