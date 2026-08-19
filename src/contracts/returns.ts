import type {
  EndpointMeta,
  ApiError,
  PaginationParams,
  SortParams,
  ListRequest,
  ListResponse,
} from "./_shared";
import type { UUID } from "@/domain/types";

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
  number: string;
  /** Manual/reference number. Optional. */
  reference?: string | null;
  kind: ReturnKind;
  date: string;
  partyId: UUID;
  partyName: string;
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

export interface CreateReturnRequest {
  kind: ReturnKind;
  date: string;
  partyId: UUID;
  originalInvoiceId?: UUID;
  lines: Array<{ rollId: UUID; quantityKg: number; pieces?: number; pricePerKg: number }>;
  reason: ReturnReason;
  currency: string;
  notesPrint?: string;
  notesInternal?: string;
}

export interface ReturnFilter extends PaginationParams, SortParams {
  kind?: ReturnKind;
  partyId?: UUID;
  status?: ReturnStatus | "all";
  fromDate?: string;
  toDate?: string;
}
export type ListReturnsRequest = ListRequest<ReturnFilter>;
export type ListReturnsResponse = ListResponse<ReturnDTO>;
export type ListReturnsError = ApiError;
export const ListReturnsEndpoint: EndpointMeta = {
  path: "/api/returns",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List returns with filtering and pagination",
};

export type CreateReturnResponse = ReturnDTO;
export type CreateReturnError = ApiError & { code: "VALIDATION_ERROR" | "NOT_FOUND" };
export const CreateReturnEndpoint: EndpointMeta = {
  path: "/api/returns",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a new return",
};

export type GetReturnResponse = ReturnDTO;
export type GetReturnError = ApiError & { code: "NOT_FOUND" };
export const GetReturnEndpoint: EndpointMeta = {
  path: "/api/returns/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get return by ID",
};

export type CancelReturnError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const CancelReturnEndpoint: EndpointMeta = {
  path: "/api/returns/:id/cancel",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cancel a return",
};
