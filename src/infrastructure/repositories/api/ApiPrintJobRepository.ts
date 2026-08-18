import { TenantContext, UUID } from "@/domain/types";
import type {
  IPrintJobRepository,
  PrintJobDTO,
  CreatePrintSendInput,
  ReceivePrintInput,
} from "@/application/ports/IPrintJobRepository";
import { PrintJobApiService } from "@/infrastructure/api";

export class ApiPrintJobRepository implements IPrintJobRepository {
  constructor(private api: PrintJobApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<PrintJobDTO | null> {
    try {
      return await this.api.findById(id);
    } catch (e) {
      console.warn("[ApiRepo] PrintJob findById failed", e);
      return null;
    }
  }

  async listAll(ctx: TenantContext): Promise<PrintJobDTO[]> {
    return this.api.listAll();
  }

  async listOpen(ctx: TenantContext): Promise<PrintJobDTO[]> {
    return this.api.listOpen();
  }

  async createSend(input: CreatePrintSendInput, ctx: TenantContext): Promise<PrintJobDTO> {
    return this.api.createSend(input);
  }

  async receive(input: ReceivePrintInput, ctx: TenantContext): Promise<PrintJobDTO> {
    return this.api.receive(input);
  }
}
