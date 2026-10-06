/** Receipts and payments (with discount, linked to an invoice), and a cancelled voucher. */
import { idOf } from "./01-master-data.mjs";

export default async function vouchers({ step, state }) {
  const r1 = await step("receipt.linked", "POST", "/api/receipts", {
    kind: "receipt",
    date: "2026-02-15",
    partyId: state.customers[0],
    partyKind: "customer",
    invoiceId: state.saleInvoices[0],
    amount: 150000.75,
    discount: 2500.25,
    currency: "SYP",
    exchangeRate: 14800,
    method: "cash",
    notesPrint: "دفعة أولى",
  });
  const r2 = await step("receipt.usd", "POST", "/api/receipts", {
    kind: "receipt",
    date: "2026-02-16",
    partyId: state.customers[1],
    partyKind: "customer",
    amount: 50.5,
    currency: "USD",
    method: "transfer",
  });
  const p1 = await step("payment.supplier", "POST", "/api/payments", {
    kind: "payment",
    date: "2026-02-16",
    partyId: state.suppliers[0],
    partyKind: "supplier",
    amount: 2000000,
    currency: "SYP",
    exchangeRate: 14750,
    method: "cash",
  });
  const r3 = await step("receipt.to-cancel", "POST", "/api/receipts", {
    kind: "receipt",
    date: "2026-02-17",
    partyId: state.customers[2],
    partyKind: "customer",
    amount: 10000,
    currency: "SYP",
    exchangeRate: 14900,
    method: "cash",
  });
  state.receipts = [r1, r2, r3].map(idOf);
  state.payments = [idOf(p1)];
  const cur = await step("receipt.get", "GET", `/api/receipts/${state.receipts[2]}`);
  const version = cur?.version ?? cur?.data?.version;
  await step("receipt.cancel", "POST", `/api/receipts/${state.receipts[2]}/cancel`, { expectedVersion: version, reason: "خطأ إدخال" });
  await step("receipt.cancel.again.rejected", "POST", `/api/receipts/${state.receipts[2]}/cancel`, { expectedVersion: version, reason: "مكرر" });
  await step("receipt.list", "GET", "/api/receipts?limit=50");
  await step("receipt.list.active", "GET", "/api/receipts?status=active&limit=50");
  await step("payment.list", "GET", "/api/payments?limit=50");
}
