/**
 * T050 invoices.mjs (EUR, fractional quantities) + rounding.mjs (x.xx5 boundaries): money is
 * rounded half away from zero at 2 decimals on both engines; every line and total must agree.
 */
import { idOf } from "./01-master-data.mjs";

export default async function currencyRounding({ step, state }) {
  const roll = idOf(
    await step("roll.create.eur", "POST", "/api/inventory/rolls", {
      colorId: state.colors[2],
      rollNo: "R-EUR",
      initialKg: 80,
      remainingKg: 0,
      pricePerKg: 2.0005,
      currency: "EUR",
      supplierId: state.suppliers[1],
      entryDate: "2026-03-01",
      pieces: 8,
    }),
  );
  const line = (kg, price, extra = {}) => ({ fabricId: state.fabrics[1], colorId: state.colors[2], rollId: roll, quantityKg: kg, pricePerKg: price, pieces: 0, ...extra });
  await step("invoice.entry.eur", "POST", "/api/invoices", {
    type: "entry",
    date: "2026-03-01",
    partyId: state.suppliers[1],
    partyType: "supplier",
    currency: "EUR",
    exchangeRate: 0.92,
    lines: [line(80, 2.01, { pieces: 8 })],
  });
  // x.xx5 products: 0.33 × 15.5 = 5.115; 2.5 × 0.01 = 0.025; 1.11 × 1.05 = 1.1655; 0.07 × 0.35 = 0.0245
  const cases = [
    [0.33, 15.5],
    [2.5, 0.01],
    [1.11, 1.05],
    [0.07, 0.35],
    [3.45, 2.13],
    [12.07, 29999.99],
  ];
  for (const [i, [kg, price]] of cases.entries()) {
    await step(`invoice.sale.rounding.${i}`, "POST", "/api/invoices", {
      type: "sale",
      date: "2026-03-02",
      partyId: state.customers[2],
      partyType: "customer",
      currency: "EUR",
      exchangeRate: 0.93,
      lines: [line(kg, price)],
      discount: i === 2 ? 0.01 : undefined,
    });
  }
  await step("invoice.sale.multiline.eur", "POST", "/api/invoices", {
    type: "sale",
    date: "2026-03-03",
    partyId: state.customers[2],
    partyType: "customer",
    currency: "EUR",
    exchangeRate: 0.93,
    lines: [line(1.01, 3.33), line(0.99, 0.05), line(4.44, 4.45, { discountAmount: 0.05 })],
    tax: 0.15,
    shipping: 0.35,
    paid: 5.55,
    paymentMethod: "cash",
  });
  await step("statement.customer.2.eur", "GET", `/api/customers/${state.customers[2]}/statement?currency=EUR`);
  await step("invoice.list.eur", "GET", "/api/invoices?type=sale&limit=100");
}
