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

export interface PaymentDTO {
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

export interface CreatePaymentRequest {
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

export interface PaymentFilter extends PaginationParams, SortParams {
  partyId?: UUID;
  invoiceId?: UUID;
  status?: string;
  fromDate?: string;
  toDate?: string;
}
export type ListPaymentsRequest = ListRequest<PaymentFilter>;
export type ListPaymentsResponse = ListResponse<PaymentDTO>;
export type ListPaymentsError = ApiError;
export const ListPaymentsEndpoint: EndpointMeta = {
  path: "/api/payments",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List payment vouchers",
};

export type CreatePaymentResponse = PaymentDTO;
export type CreatePaymentError = ApiError & { code: "VALIDATION_ERROR" };
export const CreatePaymentEndpoint: EndpointMeta = {
  path: "/api/payments",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a payment voucher (money going out)",
};

export type GetPaymentResponse = PaymentDTO;
export type GetPaymentError = ApiError & { code: "NOT_FOUND" };
export const GetPaymentEndpoint: EndpointMeta = {
  path: "/api/payments/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get payment by ID",
};

export type CancelPaymentError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const CancelPaymentEndpoint: EndpointMeta = {
  path: "/api/payments/:id/cancel",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cancel a payment voucher",
};
