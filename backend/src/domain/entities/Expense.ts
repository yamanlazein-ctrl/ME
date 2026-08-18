import type { UUID, EntityStatus } from "../types/index.js";

export interface ExpenseData {
  id: UUID;
  tenantId: UUID;
  number: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  date: string;
  method: string;
  paidFromCashbox: boolean;
  status: EntityStatus;
  notesPrint?: string;
  notesInternal?: string;
  createdAt: string;
  createdBy?: UUID;
  cancelledAt?: string;
  cancelledBy?: UUID;
}

export class Expense {
  private constructor(private readonly data: ExpenseData) {}

  static create(input: CreateExpenseInput, number: string): Expense {
    return new Expense({
      id: "" as UUID,
      tenantId: "" as UUID,
      number,
      category: input.category,
      description: input.description,
      amount: input.amount,
      currency: input.currency ?? "SYP",
      date: input.date,
      method: input.method,
      paidFromCashbox: input.paidFromCashbox ?? true,
      status: "active" as EntityStatus,
      notesPrint: input.notesPrint?.trim(),
      notesInternal: input.notesInternal?.trim(),
      createdAt: "",
      createdBy: undefined,
      cancelledAt: undefined,
      cancelledBy: undefined,
    });
  }

  static reconstitute(data: ExpenseData): Expense {
    return new Expense(data);
  }

  cancel(cancelledBy: UUID): void {
    if (this.data.status === "cancelled") throw new Error("Expense already cancelled");
    this.data.status = "cancelled";
    this.data.cancelledAt = new Date().toISOString();
    this.data.cancelledBy = cancelledBy;
  }

  toData(): ExpenseData {
    return { ...this.data };
  }
  get id(): UUID {
    return this.data.id;
  }
  get amount(): number {
    return this.data.amount;
  }
  get status(): EntityStatus {
    return this.data.status;
  }
}

export interface CreateExpenseInput {
  category: string;
  description: string;
  amount: number;
  currency?: string;
  date: string;
  method: string;
  paidFromCashbox?: boolean;
  notesPrint?: string;
  notesInternal?: string;
}
