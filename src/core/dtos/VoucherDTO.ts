import type { Currency } from "@/domain/types";
import type { VoucherKind, VoucherMethod } from "@/domain/entities/Voucher";

export type VoucherDTO = {
  id: string;
  tenantId: string;
  number: string;
  kind: VoucherKind;
  date: string;
  partyId: string;
  partyKind: "customer" | "supplier";
  invoiceId?: string | null;
  amount: number;
  currency: Currency;
  method: VoucherMethod;
  notesPrint?: string | null;
  notesInternal?: string | null;
  status: "active" | "cancelled";
  createdAt: string;
};

export type CreateVoucherInput = {
  kind: VoucherKind;
  date: string;
  partyId: string;
  partyKind: "customer" | "supplier";
  invoiceId?: string;
  amount: number;
  currency: Currency;
  method: VoucherMethod;
  notesPrint?: string;
  notesInternal?: string;
};

export type VoucherFilter = {
  kind?: VoucherKind;
  partyId?: string;
  invoiceId?: string;
  fromDate?: string;
  toDate?: string;
  status?: "active" | "cancelled" | "all";
  limit?: number;
  offset?: number;
};
