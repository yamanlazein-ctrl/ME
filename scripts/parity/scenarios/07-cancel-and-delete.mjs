/** Cancellation reversals (invoice) and party deletion rules (D-4: cancelled hidden from lists). */
export default async function cancelAndDelete({ step, state }) {
  const inv = state.saleInvoices[3];
  const cur = await step("invoice.get.to-cancel", "GET", `/api/invoices/${inv}`);
  const version = cur?.version ?? cur?.data?.version;
  await step("invoice.cancel", "POST", `/api/invoices/${inv}/cancel`, { expectedVersion: version, reason: "إلغاء بطلب الزبون" });
  await step("invoice.cancel.stale-version.rejected", "POST", `/api/invoices/${state.saleInvoices[2]}/cancel`, { expectedVersion: 999, reason: "x" });
  await step("invoice.list.after-cancel", "GET", "/api/invoices?type=sale&limit=50");
  await step("invoice.list.cancelled", "GET", "/api/invoices?type=sale&status=cancelled&limit=50");
  const c0 = await step("customer.get.before-delete", "GET", `/api/customers/${state.customers[0]}`);
  await step("party.delete.with-history.rejected", "DELETE", `/api/customers/${state.customers[0]}?expectedVersion=${c0?.version ?? c0?.data?.version}`, { expectedVersion: c0?.version ?? c0?.data?.version });
  const tmp = await step("customer.create.disposable", "POST", "/api/customers", { kind: "customer", name: "زبون مؤقت" });
  const tid = tmp.id ?? tmp.data?.id;
  await step("party.delete.clean", "DELETE", `/api/customers/${tid}?expectedVersion=${tmp.version ?? tmp.data?.version}`, { expectedVersion: tmp.version ?? tmp.data?.version });
  await step("customer.list.after-delete", "GET", "/api/customers?limit=50");
  // D-4: hidden from lists, still readable by id (history presence)
  await step("customer.get.after-delete", "GET", `/api/customers/${tid}`);
  // return cancellation reverses its stock and ledger effect
  const ret = await step("return.get.to-cancel", "GET", `/api/returns/${state.returns[1]}`);
  await step("return.cancel", "POST", `/api/returns/${state.returns[1]}/cancel`, { expectedVersion: ret?.version ?? ret?.data?.version, reason: "إلغاء مرتجع" });
  await step("return.list.after-cancel", "GET", "/api/returns?limit=50");
  await step("roll.list.final", "GET", "/api/inventory/rolls?limit=50");
}
