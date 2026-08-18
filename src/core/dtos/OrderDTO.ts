import { UUID, Currency } from "@/domain/types";
import type { OrderStatus } from "@/domain/entities/Order";

export interface OrderItemDTO {
  id: UUID;
  fabricId?: UUID | null;
  fabricName: string;
  colorId?: UUID | null;
  colorName: string;
  colorCode?: string | null;
  requestedKg: number;
  widthCm?: number | null;
  weightGsm?: number | null;
  notes?: string | null;
}

export interface OrderDTO {
  id: UUID;
  tenantId: UUID;
  code: string;
  customerId?: UUID | null;
  customerNameSnapshot: string;
  customerPhoneSnapshot?: string | null;
  date: string;
  status: OrderStatus;
  notes?: string | null;
  currency: Currency;
  items: readonly OrderItemDTO[];
  fulfilledInvoiceId?: UUID | null;
  createdAt: string;
  createdBy: string;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
}

export interface CreateOrderInput {
  customerId?: UUID | null;
  customerNameSnapshot: string;
  customerPhoneSnapshot?: string | null;
  date: string;
  notes?: string | null;
  currency: Currency;
  items: Array<{
    fabricId?: UUID | null;
    fabricName: string;
    colorId?: UUID | null;
    colorName: string;
    colorCode?: string | null;
    requestedKg: number;
    widthCm?: number | null;
    weightGsm?: number | null;
    notes?: string | null;
  }>;
}

export interface UpdateOrderInput {
  customerId?: UUID | null;
  customerNameSnapshot?: string;
  customerPhoneSnapshot?: string | null;
  date?: string;
  notes?: string | null;
  currency?: Currency;
  status?: OrderStatus;
}

export type OrderFilter = {
  customerId?: UUID;
  status?: OrderStatus | "all";
  search?: string;
  limit?: number;
  offset?: number;
};
