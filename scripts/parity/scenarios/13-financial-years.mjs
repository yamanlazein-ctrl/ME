/** T050 financial-years.mjs: close (typed confirmation), yearly summaries, reopen. Runs last. */
export default async function financialYears({ step }) {
  await step("fy.list.before", "GET", "/api/financial-years");
  // rolls created after counting began must be counted too before the year can close
  const sheet = await step("fy.count-sheet", "GET", "/api/financial-years/count-sheet?year=2026&limit=500");
  const pending = (sheet?.lines ?? []).filter((x) => x.status === "uncounted").sort((a, b) => (a.rollNo < b.rollNo ? -1 : 1));
  for (const [i, l] of pending.entries()) {
    await step(`fy.count.${i}`, "POST", "/api/financial-years/counts", { year: 2026, rollId: l.rollId, countedKg: l.bookKg, countedPieces: l.bookPieces });
  }
  await step("fy.preview", "GET", "/api/financial-years/2026/closing-preview");
  await step("fy.close.no-confirm.rejected", "POST", "/api/financial-years/close", { year: 2026, confirm: "نعم" });
  await step("fy.close", "POST", "/api/financial-years/close", { year: 2026, confirm: "إقفال", reason: "نهاية السنة" });
  await step("fy.list.closed", "GET", "/api/financial-years");
  await step("fy.write-in-closed-year.rejected", "POST", "/api/cashbox/manual-movements", {
    date: "2026-06-01",
    type: "capital",
    direction: "in",
    amount: 100,
    currency: "SYP",
  });
  await step("fy.reopen.short-reason.rejected", "POST", "/api/financial-years/reopen", { year: 2026, reason: "x" });
  await step("fy.reopen", "POST", "/api/financial-years/reopen", { year: 2026, reason: "تصحيح قيد بعد الإقفال" });
  await step("fy.list.reopened", "GET", "/api/financial-years");
  await step("reports.party-balances.final", "GET", "/api/reports/party-balances");
  await step("dashboard.final", "GET", "/api/dashboard");
}
