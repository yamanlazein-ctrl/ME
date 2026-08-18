import type { UUID, ManualMovementType, MovementDirection } from "../types/index.js";

export interface CashboxSessionData {
  id: UUID;
  tenantId: UUID;
  openingBalance: number;
  openingDate: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManualMovementData {
  id: UUID;
  tenantId: UUID;
  date: string;
  type: ManualMovementType;
  direction: MovementDirection;
  amount: number;
  currency: string;
  description?: string;
  notesInternal?: string;
  createdAt: string;
  createdBy?: UUID;
}

export interface DayCloseData {
  id: UUID;
  tenantId: UUID;
  date: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  expected: number;
  counted: number;
  difference: number;
  currency: string;
  closedAt: string;
  closedBy?: UUID;
}

export interface CashboxState {
  session: CashboxSessionData | null;
  isLocked: boolean;
  lastClosing: DayCloseData | null;
}

export class CashboxSession {
  private constructor(private readonly data: CashboxSessionData) {}

  static create(input: CreateCashboxSessionInput): CashboxSession {
    return new CashboxSession({
      id: "" as UUID,
      tenantId: "" as UUID,
      openingBalance: input.openingBalance,
      openingDate: input.openingDate,
      currency: input.currency ?? "SYP",
      createdAt: "",
      updatedAt: "",
    });
  }

  static reconstitute(data: CashboxSessionData): CashboxSession {
    return new CashboxSession(data);
  }

  toData(): CashboxSessionData {
    return { ...this.data };
  }
  get openingBalance(): number {
    return this.data.openingBalance;
  }
}

export class ManualMovement {
  private constructor(private readonly data: ManualMovementData) {}

  static create(input: CreateManualMovementInput): ManualMovement {
    return new ManualMovement({
      id: "" as UUID,
      tenantId: "" as UUID,
      date: input.date,
      type: input.type,
      direction: input.direction,
      amount: input.amount,
      currency: input.currency ?? "SYP",
      description: input.description,
      notesInternal: input.notesInternal,
      createdAt: "",
      createdBy: undefined,
    });
  }

  static reconstitute(data: ManualMovementData): ManualMovement {
    return new ManualMovement(data);
  }
  toData(): ManualMovementData {
    return { ...this.data };
  }
}

export class DayClose {
  private constructor(private readonly data: DayCloseData) {}

  static create(input: CreateDayCloseInput): DayClose {
    const expected = input.openingBalance + input.totalIn - input.totalOut;
    return new DayClose({
      id: "" as UUID,
      tenantId: "" as UUID,
      date: input.date,
      openingBalance: input.openingBalance,
      totalIn: input.totalIn,
      totalOut: input.totalOut,
      expected,
      counted: input.counted,
      difference: input.counted - expected,
      currency: input.currency ?? "SYP",
      closedAt: "",
      closedBy: undefined,
    });
  }

  static reconstitute(data: DayCloseData): DayClose {
    return new DayClose(data);
  }
  toData(): DayCloseData {
    return { ...this.data };
  }
}

export interface CreateCashboxSessionInput {
  openingBalance: number;
  openingDate: string;
  currency?: string;
}

export interface CreateManualMovementInput {
  date: string;
  type: ManualMovementType;
  direction: MovementDirection;
  amount: number;
  currency?: string;
  description?: string;
  notesInternal?: string;
}

export interface CreateDayCloseInput {
  date: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  counted: number;
  currency?: string;
}
