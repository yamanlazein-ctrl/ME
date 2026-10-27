// Customer orders (FR-27). Reads go through the order repository; every write is in documents.ts. Pending conflicts (other
// open orders asking for the same fabric/colour) are informational and read-only here: resolving them is a desktop task.
import type { OrderData } from "@backend/domain/entities/Order";
import type { Phone } from "./phone";

export const CONFLICT_NOTE = "يجب الحل من الديسكتوب";

export const ORDER_STATUS_LABEL: Record<string, string> = {
  open: "مفتوح",
  partially_available: "متوفر جزئياً",
  available: "متوفر",
  fulfilled: "منفّذ",
  cancelled: "ملغى",
};

/** An order that can still be cancelled or fulfilled (the desktop repository's own list of statuses). */
export const isOrderActive = (status: string): boolean =>
  status === "open" || status === "partially_available" || status === "available";

export interface OrderRow {
  id: string;
  code: string;
  customer: string;
  date: string;
  status: string;
  version: number;
  totalKg: number;
}

const toRow = (o: OrderData): OrderRow => ({
  id: o.id,
  code: o.code,
  customer: o.customerNameSnapshot,
  date: o.date,
  status: o.status,
  version: o.version,
  totalKg: o.items.reduce((s, i) => s + Number(i.requestedKg), 0),
});

export async function listOrders(phone: Phone): Promise<OrderRow[]> {
  const page = await phone.repos.orderRepo.list({ limit: 100 } as never, phone.context());
  return page.data.map(toRow);
}

export interface OrderDetail {
  order: OrderData;
  conflicts: Array<{ orderId: string; code: string; customer: string; items: string[] }>;
}

export async function loadOrder(phone: Phone, id: string): Promise<OrderDetail | null> {
  const ctx = phone.context();
  const order = await phone.repos.orderRepo.findById(id, ctx);
  if (!order) return null;
  let conflicts: OrderDetail["conflicts"] = [];
  if (isOrderActive(order.status)) {
    const found = await phone.repos.orderRepo.findPendingConflicts(
      order.items.map((i) => ({
        fabricId: i.fabricId ?? null,
        colorId: i.colorId ?? null,
        quantityKg: Number(i.requestedKg),
      })),
      ctx,
    );
    conflicts = found
      .filter((c) => c.orderId !== order.id)
      .map((c) => ({
        orderId: c.orderId,
        code: c.code,
        customer: c.customerNameSnapshot,
        items: c.items.map((i) => `${i.fabricName} · ${i.colorName} · ${i.requestedKg} كغ`),
      }));
  }
  return { order, conflicts };
}

/** Active sale invoices of the order's customer, to mark one as the invoice that fulfilled the order. */
export async function listFulfilCandidates(
  phone: Phone,
  customerId: string,
): Promise<Array<{ id: string; number: string; date: string }>> {
  const page = await phone.repos.invoiceRepo.list(
    { partyId: customerId, type: "sale", status: "active", limit: 20 },
    phone.context(),
  );
  return page.data.map((i) => ({ id: i.id, number: i.number, date: i.date }));
}
