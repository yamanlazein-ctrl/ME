import { TenantContext, UUID } from "@/domain/types";
import type {
  IPrintJobRepository,
  PrintJobDTO,
  CreatePrintSendInput,
  ReceivePrintInput,
} from "@/application/ports/IPrintJobRepository";
import { PrintJobApiService } from "@/infrastructure/api";

/**
 * Backend PrintJobData uses quantityKg/date/resultRollId;
 * FE PrintJobDTO historically used sentKg/sentDate/newRollId.
 * Normalize every response so UI history tables show real quantities.
 */
function adaptPrintJob(raw: Record<string, unknown>): PrintJobDTO {
  const quantityKg = Number(raw.quantityKg ?? raw.sentKg ?? 0);
  const date = String(raw.date ?? raw.sentDate ?? "");
  const receivedAt = (raw.receivedAt ?? raw.receivedDate ?? null) as string | null;
  return {
    id: raw.id as UUID,
    tenantId: raw.tenantId as UUID,
    number: String(raw.number ?? ""),
    sentDate: date,
    sourceRollId: raw.sourceRollId as UUID,
    sourceFabricId: (raw.sourceFabricId ?? "") as UUID,
    sourceColorId: (raw.sourceColorId ?? "") as UUID,
    sentKg: quantityKg,
    pieces: raw.pieces != null ? Number(raw.pieces) : undefined,
    pressName: String(raw.pressName ?? ""),
    notes: (raw.notes as string | null | undefined) ?? null,
    status: raw.status as PrintJobDTO["status"],
    receivedDate: receivedAt ? String(receivedAt).slice(0, 10) : null,
    receivedKg: raw.receivedKg != null ? Number(raw.receivedKg) : null,
    printCostPerKg: raw.printCostPerKg != null ? Number(raw.printCostPerKg) : null,
    currency: (raw.currency as string | null | undefined) ?? null,
    newFabricId: (raw.resultFabricId ?? raw.newFabricId ?? null) as UUID | null,
    newColorId: (raw.resultColorId ?? raw.newColorId ?? null) as UUID | null,
    newRollId: (raw.resultRollId ?? raw.newRollId ?? null) as UUID | null,
    newName: (raw.newName as string | null | undefined) ?? null,
    newSalePricePerKg: raw.newSalePricePerKg != null ? Number(raw.newSalePricePerKg) : null,
    receiveNotes: (raw.receiveNotes as string | null | undefined) ?? null,
  };
}

export class ApiPrintJobRepository implements IPrintJobRepository {
  constructor(private api: PrintJobApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<PrintJobDTO | null> {
    void ctx;
    try {
      const raw = await this.api.findById(id);
      return adaptPrintJob(raw as unknown as Record<string, unknown>);
    } catch (e) {
      console.warn("[ApiRepo] PrintJob findById failed", e);
      return null;
    }
  }

  async listAll(ctx: TenantContext): Promise<PrintJobDTO[]> {
    void ctx;
    const rows = await this.api.listAll();
    return rows.map((r) => adaptPrintJob(r as unknown as Record<string, unknown>));
  }

  async listOpen(ctx: TenantContext): Promise<PrintJobDTO[]> {
    void ctx;
    const rows = await this.api.listOpen();
    return rows.map((r) => adaptPrintJob(r as unknown as Record<string, unknown>));
  }

  async createSend(input: CreatePrintSendInput, ctx: TenantContext): Promise<PrintJobDTO> {
    void ctx;
    const raw = await this.api.createSend(input);
    return adaptPrintJob(raw as unknown as Record<string, unknown>);
  }

  async receive(input: ReceivePrintInput, ctx: TenantContext): Promise<PrintJobDTO> {
    void ctx;
    const raw = await this.api.receive(input);
    return adaptPrintJob(raw as unknown as Record<string, unknown>);
  }
}
