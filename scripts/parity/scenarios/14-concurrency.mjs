/**
 * T050 concurrency.mjs (runs LAST: later reads would observe the timing of the parallel writes): parallel same-roll consumption and parallel same-document-number
 * allocation. Which request wins is timing-dependent on EITHER engine, so the recorded result is
 * the invariant outcome: how many succeeded, the sorted numbers handed out, and the roll's stock.
 */
import { idOf } from "./01-master-data.mjs";

export default async function concurrency({ step, record, api, state }) {
  const roll = idOf(
    await step("conc.roll", "POST", "/api/inventory/rolls", {
      colorId: state.colors[0],
      rollNo: "R-CONC",
      initialKg: 10,
      remainingKg: 0,
      pricePerKg: 20000,
      currency: "SYP",
      supplierId: state.suppliers[0],
      entryDate: "2026-05-01",
      pieces: 20,
    }),
  );
  await step("conc.entry", "POST", "/api/invoices", {
    type: "entry",
    date: "2026-05-01",
    partyId: state.suppliers[0],
    partyType: "supplier",
    currency: "SYP",
    exchangeRate: 15000,
    lines: [{ fabricId: state.fabrics[0], colorId: state.colors[0], rollId: roll, quantityKg: 10, pricePerKg: 20000, pieces: 20 }],
  });
  const sale = (kg) =>
    api.call("POST", "/api/invoices", {
      type: "sale",
      date: "2026-05-02",
      partyId: state.customers[0],
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 15000,
      lines: [{ fabricId: state.fabrics[0], colorId: state.colors[0], rollId: roll, quantityKg: kg, pricePerKg: 25000, pieces: 1 }],
    }, { tag: "conc" });

  // 5 × 3 kg against 10 kg: exactly 3 may succeed, stock never goes negative
  const sameRoll = await Promise.all([3, 3, 3, 3, 3].map((kg) => sale(kg)));
  record("conc.same-roll.outcome", {
    statuses: sameRoll.map((r) => r.status).sort(),
    numbers: sameRoll.filter((r) => r.status < 300).map((r) => r.body.number).sort(),
  });
  await step("conc.same-roll.roll", "GET", `/api/inventory/rolls?limit=100`);

  // 6 parallel sales on another roll (enough stock): numbers unique and gapless
  const many = await Promise.all(
    Array.from({ length: 6 }, () =>
      api.call("POST", "/api/invoices", {
        type: "sale",
        date: "2026-05-03",
        partyId: state.customers[1],
        partyType: "customer",
        currency: "USD",
        lines: [{ fabricId: state.fabrics[1], colorId: state.colors[2], rollId: state.rolls[2], quantityKg: 0.5, pricePerKg: 5.5, pieces: 0 }],
      }, { tag: "conc" }),
    ),
  );
  const nums = many.filter((r) => r.status < 300).map((r) => r.body.number).sort();
  const seqOf = (n) => Number(String(n).split("-").at(-1));
  record("conc.numbering.outcome", {
    statuses: many.map((r) => r.status).sort(),
    numbers: nums,
    unique: new Set(nums).size === nums.length,
    gapless: nums.every((n, i) => i === 0 || seqOf(n) === seqOf(nums[i - 1]) + 1),
  });
}
