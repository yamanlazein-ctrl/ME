import type { EndpointMeta, ApiError } from "./_shared";
import type { UUID } from "@/domain/types";

export type ManualMovementType =
  "capital" | "withdrawal" | "transfer" | "adjustment" | "correction";
export type MovementDirection = "in" | "out";

export interface CashboxSessionData {
  id: UUID;
  tenantId: UUID;
  openingBalance: number;
  openingDate: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashboxStateDTO {
  session: CashboxSessionData | null;
  isLocked: boolean;
  lastClosing: DailyClosingDTO | null;
}

export interface ManualMovementDTO {
  id: UUID;
  date: string;
  type: ManualMovementType;
  direction: MovementDirection;
  amount: number;
  currency: string;
  description: string;
  notesInternal?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface DailyClosingDTO {
  id: UUID;
  date: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  expected: number;
  counted: number;
  difference: number;
  currency: string;
  closedAt: string;
  closedBy: string;
}

export interface DayCashFlowDTO {
  in: number;
  out: number;
}

export interface CreateManualMovementRequest {
  date: string;
  type: ManualMovementType;
  direction: MovementDirection;
  amount: number;
  currency: string;
  description: string;
  notesInternal?: string;
}

export interface CloseDayRequest {
  date: string;
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  counted: number;
  currency: string;
}

export type GetCashboxStateError = ApiError;
export const GetCashboxStateEndpoint: EndpointMeta = {
  path: "/api/cashbox/state",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get current cashbox opening state",
};

export interface SetOpeningBalanceRequest {
  openingBalance: number;
  openingDate: string;
  currency?: string;
}
export type SetOpeningBalanceError = ApiError;
export const SetOpeningBalanceEndpoint: EndpointMeta = {
  path: "/api/cashbox/opening-balance",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Set cashbox opening balance",
};

export const GetCashBalanceEndpoint: EndpointMeta = {
  path: "/api/cashbox/balance/:date",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get cash balance on a specific date",
};

export const GetCashMovementsEndpoint: EndpointMeta = {
  path: "/api/cashbox/movements/:date",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get cash inflow/outflow for a date",
};

export const IsDayLockedEndpoint: EndpointMeta = {
  path: "/api/cashbox/locked/:date",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Check if a day is locked",
};

export type ListManualMovementsResponse = ManualMovementDTO[];
export type ListManualMovementsError = ApiError;
export const ListManualMovementsEndpoint: EndpointMeta = {
  path: "/api/cashbox/manual-movements",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "List all manual cashbox movements",
};

export type CreateManualMovementResponse = ManualMovementDTO;
export type CreateManualMovementError = ApiError & { code: "VALIDATION_ERROR" | "DAY_LOCKED" };
export const CreateManualMovementEndpoint: EndpointMeta = {
  path: "/api/cashbox/manual-movements",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Add a manual cashbox movement",
};

export type DeleteManualMovementError = ApiError & { code: "NOT_FOUND" | "DAY_LOCKED" };
export const DeleteManualMovementEndpoint: EndpointMeta = {
  path: "/api/cashbox/manual-movements/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a manual movement",
};

export type CloseDayResponse = DailyClosingDTO;
export type CloseDayError = ApiError & { code: "VALIDATION_ERROR" | "DAY_LOCKED" | "MISMATCH" };
export const CloseDayEndpoint: EndpointMeta = {
  path: "/api/cashbox/close-day",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Close cashbox for a day with counted amount",
};

export type ListClosingsResponse = DailyClosingDTO[];
export type ListClosingsError = ApiError;
export const ListClosingsEndpoint: EndpointMeta = {
  path: "/api/cashbox/closings",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List all daily closings",
};

export type GetLastClosingResponse = DailyClosingDTO | null;
export type GetLastClosingError = ApiError;
export const GetLastClosingEndpoint: EndpointMeta = {
  path: "/api/cashbox/closings/last",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get the most recent daily closing",
};
