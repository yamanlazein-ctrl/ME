/** Inventory counts (T050 inventory.mjs part 2): begin counting, count sheet, record a variance, post it. */
export default async function inventoryCounts({ step, state }) {
  await step("counting.begin", "POST", "/api/financial-years/begin-counting", { year: 2026 });
  const sheet = await step("counting.sheet", "GET", "/api/financial-years/count-sheet?year=2026&limit=100");
  // count every roll at its book figure, except R-002: 1.25 kg and one piece short (a variance)
  // by natural key: the sheet is ordered by roll id, which is random per run on either engine
  const lines = [...(sheet?.lines ?? [])].sort((a, b) => (a.rollNo < b.rollNo ? -1 : 1));
  for (const [i, l] of lines.entries()) {
    const short = l.rollId === state.rolls[1];
    await step(`counting.record.${i}`, "POST", "/api/financial-years/counts", {
      year: 2026,
      rollId: l.rollId,
      countedKg: short ? Math.round((l.bookKg - 1.25) * 100) / 100 : l.bookKg,
      countedPieces: short ? l.bookPieces - 1 : l.bookPieces,
      reason: short ? "جرد فعلي" : undefined,
    });
  }
  // the variance is posted as a stock adjustment (its count id comes from the sheet)
  const after = await step("counting.sheet.after", "GET", "/api/financial-years/count-sheet?year=2026&limit=100");
  const variance = (after?.lines ?? []).find((l) => l.rollId === state.rolls[1]);
  await step("counting.post", "POST", "/api/financial-years/counts/post", { countId: variance?.countId });
  await step("counting.sheet.posted", "GET", "/api/financial-years/count-sheet?year=2026&limit=100");
  await step("roll.after-count", "GET", `/api/inventory/rolls?limit=50`);
}
