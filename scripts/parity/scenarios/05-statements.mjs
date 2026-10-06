/** Statements, multi-invoice settlement, credit, ledger balance. */
export default async function statements({ step, state }) {
  const [c0, c1] = state.customers;
  await step("statement.customer.0", "GET", `/api/customers/${c0}/statement`);
  await step("statement.customer.1", "GET", `/api/customers/${c1}/statement`);
  await step("settle.invoices", "POST", `/api/customers/${c1}/statement/settle-invoices`, {
    invoiceIds: [state.saleInvoices[2]],
    amountPaid: 300000,
    discount: 1500.5,
    currency: "SYP",
    exchangeRate: 14900,
    date: "2026-02-21",
    method: "cash",
  });
  await step("statement.customer.1.after-settle", "GET", `/api/customers/${c1}/statement`);
  await step("statement.supplier.0", "GET", `/api/suppliers/${state.suppliers[0]}/statement`);
  await step("credit.customer.0", "GET", `/api/customers/${c0}/credit?currency=SYP`);
  await step("ledger.balance.customer.0", "GET", `/api/ledger/balance/${c0}`);
  await step("ledger.party.customer.1", "GET", `/api/ledger/party/${c1}`);
  await step("ledger.balance.at-date", "GET", `/api/ledger/balance/${c0}/2026-02-12`);
  await step("ledger.list", "GET", "/api/ledger?limit=200");
}
