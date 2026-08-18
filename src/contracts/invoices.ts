import type {
  EndpointMeta,
  ApiError,
  PaginationParams,
  SortParams,
  ListRequest,
  ListResponse,
} from "./_shared";
import type { InvoiceData, InvoiceLineData } from "@/domain/entities/Invoice";
import type { UUID, Currency } from "@/domain/types";

export type { InvoiceData, InvoiceLineData };

export interface InvoiceDTO {
  id: UUID;
  number: string;
  type: "entry" | "sale" | "return";
  date: string;
  partyId: UUID;
  partyType: "customer" | "supplier";
  partyName: string;
  currency: Currency;
  status: "draft" | "active" | "cancelled";
  lines: InvoiceLineData[];
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
  notes?: string;
  createdAt: string;
  createdBy: string;
  version: number;
  cancelledAt?: string | null;
}

export interface CreateInvoiceRequest {
  type: "entry" | "sale" | "return";
  date: string;
  partyId: UUID;
  partyType: "customer" | "supplier";
  currency: Currency;
  discount?: number;
  tax?: number;
  shipping?: number;
  /** Amount received at sale time → creates a linked receipt voucher atomically. */
  paid?: number;
  paymentMethod?: "cash" | "transfer" | "check" | "card";
  /** Order being fulfilled by this invoice — allows its reserved rolls to be sold. */
  orderId?: UUID;
  lines: Array<{
    fabricId: UUID;
    colorId: UUID;
    rollId: UUID;
    quantityKg: number;
    pricePerKg: number;
    discountAmount: number;
    note?: string;
  }>;
  notes?: string;
}

export interface InvoiceFilter extends PaginationParams, SortParams {
  partyId?: UUID;
  type?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
}
export type ListInvoicesRequest = ListRequest<InvoiceFilter>;
export type ListInvoicesResponse = ListResponse<InvoiceDTO>;
export type ListInvoicesError = ApiError;
export const ListInvoicesEndpoint: EndpointMeta = {
  path: "/api/invoices",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List invoices with filtering and pagination",
};

export type CreateInvoiceResponse = InvoiceDTO;
export type CreateInvoiceError = ApiError & { code: "VALIDATION_ERROR" | "INSUFFICIENT_STOCK" };
export const CreateInvoiceEndpoint: EndpointMeta = {
  path: "/api/invoices",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a new invoice",
};

export type GetInvoiceResponse = InvoiceDTO;
export type GetInvoiceError = ApiError & { code: "NOT_FOUND" };
export const GetInvoiceEndpoint: EndpointMeta = {
  path: "/api/invoices/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get invoice by ID",
};

export type GetInvoiceByNumberResponse = InvoiceDTO;
export type GetInvoiceByNumberError = ApiError & { code: "NOT_FOUND" };
export const GetInvoiceByNumberEndpoint: EndpointMeta = {
  path: "/api/invoices/number/:number",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get invoice by document number",
};

export type UpdateInvoiceResponse = InvoiceDTO;
export type UpdateInvoiceError = ApiError & {
  code: "NOT_FOUND" | "VALIDATION_ERROR" | "INVALID_STATE";
};
export const UpdateInvoiceEndpoint: EndpointMeta = {
  path: "/api/invoices/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Update invoice (draft only)",
};

export type CancelInvoiceResponse = InvoiceDTO;
export type CancelInvoiceError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const CancelInvoiceEndpoint: EndpointMeta = {
  path: "/api/invoices/:id/cancel",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cancel an active invoice",
};
