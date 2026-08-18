import type {
  EndpointMeta,
  ApiError,
  PaginationParams,
  SortParams,
  ListRequest,
  ListResponse,
} from "./_shared";
import type { UUID, Currency } from "@/domain/types";
import type { VoucherMethod } from "@/domain/entities/Voucher";

export interface ReceiptDTO {
  id: UUID;
  number: string;
  date: string;
  partyId: UUID;
  partyName: string;
  invoiceId?: UUID | null;
  amount: number;
  currency: Currency;
  method: VoucherMethod;
  notesPrint?: string | null;
  notesInternal?: string | null;
  status: "active" | "cancelled";
  createdAt: string;
}

export interface CreateReceiptRequest {
  kind?: "payment" | "receipt";
  date: string;
  partyId: UUID;
  partyKind?: "customer" | "supplier";
  invoiceId?: UUID;
  amount: number;
  currency: Currency;
  method: VoucherMethod;
  notesPrint?: string;
  notesInternal?: string;
}

export interface ReceiptFilter extends PaginationParams, SortParams {
  partyId?: UUID;
  invoiceId?: UUID;
  status?: string;
  fromDate?: string;
  toDate?: string;
}
export type ListReceiptsRequest = ListRequest<ReceiptFilter>;
export type ListReceiptsResponse = ListResponse<ReceiptDTO>;
export type ListReceiptsError = ApiError;
export const ListReceiptsEndpoint: EndpointMeta = {
  path: "/api/receipts",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List receipt vouchers",
};

export type CreateReceiptResponse = ReceiptDTO;
export type CreateReceiptError = ApiError & { code: "VALIDATION_ERROR" };
export const CreateReceiptEndpoint: EndpointMeta = {
  path: "/api/receipts",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a receipt voucher (money coming in)",
};

export type GetReceiptResponse = ReceiptDTO;
export type GetReceiptError = ApiError & { code: "NOT_FOUND" };
export const GetReceiptEndpoint: EndpointMeta = {
  path: "/api/receipts/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get receipt by ID",
};

export type CancelReceiptError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const CancelReceiptEndpoint: EndpointMeta = {
  path: "/api/receipts/:id/cancel",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cancel a receipt voucher",
};
