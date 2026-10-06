/** Cashbox opening, manual movements, expenses (one cancelled), day close. */
import { idOf } from "./01-master-data.mjs";

export default async function cashbox({ step, state }) {
  await step("cashbox.opening", "POST", "/api/cashbox/opening-balance", { openingBalance: 5000000, openingDate: "2026-01-31", currency: "SYP" });
  await step("cashbox.manual.capital", "POST", "/api/cashbox/manual-movements", {
    date: "2026-02-03",
    type: "capital",
    direction: "in",
    amount: 750000.5,
    currency: "SYP",
    description: "رأس مال إضافي",
  });
  await step("cashbox.manual.withdrawal", "POST", "/api/cashbox/manual-movements", {
    date: "2026-02-04",
    type: "withdrawal",
    direction: "out",
    amount: 120000,
    currency: "SYP",
  });
  const ex1 = await step("expense.cash", "POST", "/api/expenses", {
    category: "نقل",
    description: "أجور شحن",
    amount: 35000,
    currency: "SYP",
    date: "2026-02-05",
    method: "cash",
    paidFromCashbox: true,
  });
  const ex2 = await step("expense.to-cancel", "POST", "/api/expenses", {
    category: "كهرباء",
    description: "فاتورة شباط",
    amount: 82000.25,
    currency: "SYP",
    date: "2026-02-06",
    method: "cash",
    paidFromCashbox: true,
  });
  state.expenses = [ex1, ex2].map(idOf);
  const cur = await step("expense.get", "GET", `/api/expenses/${state.expenses[1]}`);
  await step("expense.cancel", "POST", `/api/expenses/${state.expenses[1]}/cancel`, { expectedVersion: cur?.version ?? cur?.data?.version, reason: "مكرر" });
  await step("expense.list", "GET", "/api/expenses?limit=50");
  await step("expense.names", "GET", "/api/expenses/names");
  await step("cashbox.state", "GET", "/api/cashbox/state");
  await step("cashbox.balance.0210", "GET", "/api/cashbox/balance/2026-02-10?currency=SYP");
  await step("cashbox.movements.0210", "GET", "/api/cashbox/movements/2026-02-10?currency=SYP");
  await step("cashbox.manual.list", "GET", "/api/cashbox/manual-movements");
  await step("cashbox.close-day", "POST", "/api/cashbox/close-day", { date: "2026-02-05", counted: 5595000.5, currency: "SYP" });
  await step("cashbox.closings", "GET", "/api/cashbox/closings");
  await step("cashbox.locked", "GET", "/api/cashbox/locked/2026-02-05");
}
