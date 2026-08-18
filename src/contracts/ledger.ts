import type {
  EndpointMeta,
  ApiError,
  PaginationParams,
  SortParams,
  ListRequest,
  ListResponse,
} from "./_shared";
import type { UUID, Currency } from "@/domain/types";
import type { LedgerType, CashImpact } from "@/domain/types";

export interface LedgerEntryDTO {
  id: UUID;
  date: string;
  type: LedgerType;
  referenceType: string;
  referenceId?: UUID | null;
  referenceNumber?: string | null;
  partyId?: UUID | null;
  partyKind?: "customer" | "supplier" | null;
  debit: number;
  credit: number;
  currency: Currency;
  cashImpact: CashImpact;
  description: string;
  notesInternal?: string | null;
  status: "active" | "cancelled";
  createdBy: string;
  createdAt: string;
  cancelledAt?: string | null;
}

export interface LedgerFilter extends PaginationParams, SortParams {
  partyId?: UUID;
  referenceId?: UUID;
  types?: LedgerType[];
  fromDate?: string;
  toDate?: string;
  status?: "active" | "cancelled" | "all";
}
export type ListLedgerRequest = ListRequest<LedgerFilter>;
export type ListLedgerResponse = ListResponse<LedgerEntryDTO>;
export type ListLedgerError = ApiError;
export const ListLedgerEndpoint: EndpointMeta = {
  path: "/api/ledger",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List ledger entries with filtering and pagination",
};

export type GetLedgerEntryResponse = LedgerEntryDTO;
export type GetLedgerEntryError = ApiError & { code: "NOT_FOUND" };
export const GetLedgerEntryEndpoint: EndpointMeta = {
  path: "/api/ledger/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get a single ledger entry by ID",
};

export interface BalanceResponse {
  partyId: UUID;
  currency: string;
  balance: number;
}
export type BalanceError = ApiError;
export const BalanceEndpoint: EndpointMeta = {
  path: "/api/ledger/balance/:partyId",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get account balance for a party in a currency",
};

export interface CashMovementsResponse {
  in: number;
  out: number;
  date: string;
  currency: string;
}
export type CashMovementsError = ApiError;
export const CashMovementsEndpoint: EndpointMeta = {
  path: "/api/ledger/cash-movements/:date",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get total cash movements for a date",
};
