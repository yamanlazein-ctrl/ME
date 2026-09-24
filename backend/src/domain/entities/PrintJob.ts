import type { UUID, PrintJobStatus } from "../types/index.js";

export interface PrintJobData {
  id: UUID;
  tenantId: UUID;
  number: string;
  date: string;
  status: PrintJobStatus;
  sourceRollId: UUID;
  sourceFabricId?: UUID;
  sourceColorId?: UUID;
  quantityKg: number;
  pieces?: number;
  pressName?: string;
  printCostPerKg?: number;
  currency: string;
  /** Units of currency per 1 USD — frozen at receive when set. */
  exchangeRate?: number;
  newName?: string;
  newCategory?: string;
  newColorName?: string;
  newColorCode?: string;
  newSalePricePerKg?: number;
  receivedKg?: number;
  /** ISO timestamp when the job was marked received (if any). */
  receivedAt?: string;
  /** Printing loss = quantityKg − receivedKg (computed, read-only). */
  wasteKg?: number;
  resultRollId?: UUID;
  resultFabricId?: UUID;
  resultColorId?: UUID;
  notes?: string;
  receiveNotes?: string;
  createdAt: string;
  createdBy?: UUID;
  customerId?: UUID;
  orderId?: UUID;
  chargePerKg?: number;
  costExpenseId?: UUID;
}

export class PrintJob {
  private constructor(private readonly data: PrintJobData) {}

  receive(
    receivedKg: number,
    opts: { number?: string; resultRollId: UUID; resultFabricId?: UUID; resultColorId?: UUID },
  ): void {
    if (this.data.status === "received") throw new Error("Print job already received");
    this.data.status = "received";
    this.data.receivedKg = receivedKg;
    this.data.resultRollId = opts.resultRollId;
    this.data.resultFabricId = opts.resultFabricId;
    this.data.resultColorId = opts.resultColorId;
  }

  markFields(partial: Partial<PrintJobData>): void {
    Object.assign(this.data, partial);
  }

  toData(): PrintJobData {
    return { ...this.data };
  }
  get id(): UUID {
    return this.data.id;
  }
  get status(): PrintJobStatus {
    return this.data.status;
  }
  get sourceRollId(): UUID {
    return this.data.sourceRollId;
  }
  get hasResult(): boolean {
    return Boolean(this.data.resultRollId);
  }
}

export interface CreatePrintJobInput {
  /** Sync replay: the job id the origin PC created (same id on every node). */
  presetId?: UUID;
  date: string;
  sourceRollId: UUID;
  sourceFabricId?: UUID;
  sourceColorId?: UUID;
  quantityKg: number;
  pieces?: number;
  pressName?: string;
  printCostPerKg?: number;
  currency?: string;
  newName?: string;
  newCategory?: string;
  newColorName?: string;
  newColorCode?: string;
  newSalePricePerKg?: number;
  notes?: string;
  customerId?: UUID;
  orderId?: UUID;
  chargePerKg?: number;
}

export interface ReceivePrintJobInput {
  /**
   * Sync replay: the ids/number the origin PC produced for the printed
   * fabric, colour and roll, so every node holds the SAME rows (a later sale
   * of the printed roll references them by id).
   */
  preset?: { resultFabricId?: UUID; resultColorId?: UUID; resultRollId?: UUID; resultRollNo?: string };
  jobId: UUID;
  date: string;
  receivedKg: number;
  printCostPerKg?: number;
  currency?: string;
  /** Required when receive currency ≠ USD (same rule as invoices). */
  exchangeRate?: number;
  newName?: string;
  newCategory?: string;
  newColorName?: string;
  newColorCode?: string;
  /** Optional swatch hex for the new inventory colour. */
  newColorHex?: string;
  newSalePricePerKg?: number;
  notes?: string;
}

export function createPrintJobData(
  input: CreatePrintJobInput,
  number: string,
  tenantId: UUID,
  createdBy: UUID,
): PrintJobData {
  return {
    id: "" as UUID,
    tenantId,
    number,
    date: input.date,
    status: "sent" as PrintJobStatus,
    sourceRollId: input.sourceRollId,
    sourceFabricId: input.sourceFabricId,
    sourceColorId: input.sourceColorId,
    quantityKg: input.quantityKg,
    pressName: input.pressName,
    printCostPerKg: input.printCostPerKg,
    currency: input.currency ?? "SYP",
    newName: input.newName,
    newCategory: input.newCategory,
    newColorName: input.newColorName,
    newColorCode: input.newColorCode,
    newSalePricePerKg: input.newSalePricePerKg,
    receivedKg: undefined,
    resultRollId: undefined,
    notes: input.notes,
    createdAt: "",
    createdBy,
  };
}
