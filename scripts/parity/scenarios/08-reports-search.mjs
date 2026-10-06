/** Read-side parity: dashboard, reports, profit, search (Arabic + Latin), keyset paging, document track. */
export default async function reports({ step, state }) {
  await step("dashboard", "GET", "/api/dashboard");
  await step("reports.summary", "GET", "/api/reports/summary?from=2026-01-01");
  for (const slug of ["net-sales", "purchases", "sales-returns", "expenses", "ledger", "cashbox", "inventory-value", "top-fabrics", "top-customers"]) {
    await step(`reports.detail.${slug}`, "GET", `/api/reports/detail/${slug}?from=2026-01-01`);
  }
  await step("reports.party-balances", "GET", "/api/reports/party-balances");
  await step("profit.summary", "GET", "/api/profit/summary?from=2026-01-01&to=2026-12-31");
  await step("profit.details", "GET", "/api/profit/details?from=2026-01-01&to=2026-12-31");
  for (const q of ["أحمد", "احمد", "beta", "BETA", "إيلاف", "النسيج", "%", "_"]) {
    await step(`search.parties.${q}`, "GET", `/api/parties/search?q=${encodeURIComponent(q)}`);
  }
  await step("search.fabrics", "GET", `/api/fabrics/search?q=${encodeURIComponent("قطن")}`);
  await step("search.colors", "GET", `/api/colors/search?q=${encodeURIComponent("bl")}&fabricId=${state.fabrics[1]}`);
  await step("search.rolls", "GET", `/api/rolls/search?q=R-00&colorId=${state.colors[0]}`);
  // /rolls/by-ids and /parties/by-ids: owner decision O-1 (always fail on PG; the unhandled rejection
  // ends the process on BOTH engines) — exercised by tests/sqlite, not here, so the run is not cut short.
  // Without fabricId/colorId both endpoints fail on PG (''::uuid, 22P02) and the process exits:
  // owner item O-2, reproduced on SQLite and pinned by tests/sqlite — not exercised here.
  // keyset paging: walk the full sale list two at a time
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await step(`invoice.keyset.page${page}`, "GET", `/api/invoices?type=sale&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    cursor = r?.nextCursor ?? r?.meta?.nextCursor ?? r?.pagination?.nextCursor;
    if (!cursor) break;
  }
  await step("document-graph", "GET", `/api/ledger/document-graph/${state.saleInvoices[0]}`);
  await step("timeline", "GET", `/api/ledger/timeline/invoice/${state.saleInvoices[0]}`);
  await step("financial-years", "GET", "/api/financial-years");
  await step("closing-preview", "GET", "/api/financial-years/2026/closing-preview");
}
