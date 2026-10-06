/** Entry (purchase) and sale invoices in SYP and USD: discounts, tax, shipping, partial payment, credit. */
import { idOf } from "./01-master-data.mjs";

export default async function invoices({ step, state }) {
  const fabricOf = (ci) => state.fabrics[ci === 2 ? 1 : 0];
  const line = (ri, kg, price, extra = {}) => ({
    fabricId: fabricOf(state.rollColor[ri]),
    colorId: state.colors[state.rollColor[ri]],
    rollId: state.rolls[ri],
    quantityKg: kg,
    pricePerKg: price,
    pieces: 1,
    ...extra,
  });

  const e1 = await step("invoice.entry.syp", "POST", "/api/invoices", {
    type: "entry",
    date: "2026-02-01",
    partyId: state.suppliers[0],
    partyType: "supplier",
    currency: "SYP",
    exchangeRate: 14750,
    lines: [line(0, 120.5, 18500.25, { pieces: 6 }), line(1, 98.75, 21000, { pieces: 6 }), line(3, 45, 19000, { pieces: 4 })],
    shipping: 25000,
    paid: 1000000,
    paymentMethod: "cash",
  });
  const e2 = await step("invoice.entry.usd", "POST", "/api/invoices", {
    type: "entry",
    date: "2026-02-02",
    partyId: state.suppliers[1],
    partyType: "supplier",
    currency: "USD",
    lines: [line(2, 60.33, 3.45, { pieces: 3 })],
    discount: 1.11,
  });
  const s1 = await step("invoice.sale.syp.partial", "POST", "/api/invoices", {
    type: "sale",
    date: "2026-02-10",
    partyId: state.customers[0],
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 14800,
    lines: [line(0, 33.33, 26500.5, { discountAmount: 1000 }), line(1, 12.07, 29999.99)],
    discount: 5000,
    tax: 1234.56,
    paid: 400000,
    paymentMethod: "cash",
  });
  const s2 = await step("invoice.sale.usd", "POST", "/api/invoices", {
    type: "sale",
    date: "2026-02-11",
    partyId: state.customers[1],
    partyType: "customer",
    currency: "USD",
    lines: [line(2, 20.01, 5.37)],
  });
  const s3 = await step("invoice.sale.syp.unpaid", "POST", "/api/invoices", {
    type: "sale",
    date: "2026-02-12",
    partyId: state.customers[1],
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 14900,
    lines: [line(3, 10.5, 27000), line(0, 7.25, 26000)],
  });
  const s4 = await step("invoice.sale.to-cancel", "POST", "/api/invoices", {
    type: "sale",
    date: "2026-02-13",
    partyId: state.customers[2],
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 14900,
    lines: [line(1, 5, 30000)],
    paid: 50000,
    paymentMethod: "cash",
  });
  state.entryInvoices = [e1, e2].map(idOf);
  state.saleInvoices = [s1, s2, s3, s4].map(idOf);

  await step("invoice.over-sell.rejected", "POST", "/api/invoices", {
    type: "sale",
    date: "2026-02-14",
    partyId: state.customers[0],
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 14900,
    lines: [line(3, 9999, 27000)],
  });
  await step("invoice.get.sale", "GET", `/api/invoices/${state.saleInvoices[0]}`);
  await step("invoice.get.entry", "GET", `/api/invoices/${state.entryInvoices[0]}`);
  await step("invoice.list.sale", "GET", "/api/invoices?type=sale&limit=50");
  await step("invoice.list.entry", "GET", "/api/invoices?type=entry&limit=50");
  await step("invoice.next-number", "GET", "/api/invoices/next-number?type=sale");
  await step("roll.list.after-invoices", "GET", "/api/inventory/rolls?limit=50");
}
