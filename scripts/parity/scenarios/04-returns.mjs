/** Sale return and purchase (entry) return against original invoices. */
import { idOf } from "./01-master-data.mjs";

export default async function returns({ step, state }) {
  const sr = await step("return.sale", "POST", "/api/returns", {
    kind: "sale",
    date: "2026-02-18",
    partyId: state.customers[0],
    originalInvoiceId: state.saleInvoices[0],
    reason: "defect",
    currency: "SYP",
    lines: [{ rollId: state.rolls[0], quantityKg: 3.33, pieces: 1, pricePerKg: 26500.5 }],
  });
  const er = await step("return.entry", "POST", "/api/returns", {
    kind: "entry",
    date: "2026-02-19",
    partyId: state.suppliers[0],
    originalInvoiceId: state.entryInvoices[0],
    reason: "wrong_quantity",
    currency: "SYP",
    lines: [{ rollId: state.rolls[3], quantityKg: 2.5, pieces: 1, pricePerKg: 19000 }],
  });
  state.returns = [sr, er].map(idOf);
  await step("return.over-return.rejected", "POST", "/api/returns", {
    kind: "sale",
    date: "2026-02-20",
    partyId: state.customers[0],
    originalInvoiceId: state.saleInvoices[0],
    reason: "other",
    currency: "SYP",
    lines: [{ rollId: state.rolls[0], quantityKg: 500, pieces: 1, pricePerKg: 26500.5 }],
  });
  await step("return.get", "GET", `/api/returns/${state.returns[0]}`);
  await step("return.list", "GET", "/api/returns?limit=50");
}
