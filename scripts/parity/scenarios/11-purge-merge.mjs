/** T050 purge-merge.mjs: party merge, party purge cascade, dye purge cascade. */
import { idOf } from "./01-master-data.mjs";

export default async function purgeMerge({ step, state }) {
  const mk = async (label, name) => idOf(await step(label, "POST", "/api/customers", { kind: "customer", name }));
  const survivor = await mk("merge.survivor", "عميل باقٍ");
  const source = await mk("merge.source", "عميل مكرر");
  const doomed = await mk("purge.party", "عميل للحذف الكامل");

  // a dedicated dye (fabric + colour + roll) with its own history, for the dye purge
  const dye = idOf(await step("dye.fabric", "POST", "/api/inventory/fabrics", { name: "صبغة للحذف" }));
  const dyeColor = idOf(await step("dye.color", "POST", "/api/inventory/colors", { fabricId: dye, name: "زهري", hex: "#ff00ff" }));
  const dyeRoll = idOf(
    await step("dye.roll", "POST", "/api/inventory/rolls", {
      colorId: dyeColor,
      rollNo: "R-DYE",
      initialKg: 30,
      remainingKg: 0,
      pricePerKg: 12000,
      currency: "SYP",
      supplierId: state.suppliers[0],
      entryDate: "2026-04-01",
      pieces: 6,
    }),
  );
  await step("dye.entry", "POST", "/api/invoices", {
    type: "entry",
    date: "2026-04-01",
    partyId: state.suppliers[0],
    partyType: "supplier",
    currency: "SYP",
    exchangeRate: 15000,
    lines: [{ fabricId: dye, colorId: dyeColor, rollId: dyeRoll, quantityKg: 30, pricePerKg: 12000, pieces: 6 }],
  });
  const sale = (party, kg, label) =>
    step(label, "POST", "/api/invoices", {
      type: "sale",
      date: "2026-04-02",
      partyId: party,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 15000,
      lines: [{ fabricId: dye, colorId: dyeColor, rollId: dyeRoll, quantityKg: kg, pricePerKg: 16000, pieces: 1 }],
      paid: 10000,
      paymentMethod: "cash",
    });
  await sale(source, 2.5, "merge.source.sale");
  await sale(survivor, 1.25, "merge.survivor.sale");
  const doomedInv = idOf(await sale(doomed, 3, "purge.party.sale"));
  await step("purge.party.receipt", "POST", "/api/receipts", {
    kind: "receipt",
    date: "2026-04-03",
    partyId: doomed,
    partyKind: "customer",
    invoiceId: doomedInv,
    amount: 5000,
    currency: "SYP",
    exchangeRate: 15000,
    method: "cash",
  });

  // party merge: refused over HTTP while sync enqueue is on (always, isSyncEnqueueEnabled) — the
  // refusal is the product behavior; the merge itself is covered by tests/party-merge.test.ts.
  await step("merge", "POST", "/api/parties/merge", { survivorId: survivor, sourceId: source });
  await step("merge.survivor.statement", "GET", `/api/customers/${survivor}/statement`);
  await step("merge.source.get", "GET", `/api/customers/${source}`);

  // party purge cascade (cancels its invoices/vouchers through accounting, soft-cancels the party)
  const p = await step("purge.party.get", "GET", `/api/customers/${doomed}`);
  const v = p?.version ?? p?.data?.version;
  await step("purge.party.cascade", "DELETE", `/api/customers/${doomed}?expectedVersion=${v}&confirmCascade=true`, { expectedVersion: v, confirmCascade: true });
  await step("purge.party.after", "GET", `/api/customers/${doomed}`);
  await step("purge.party.statement", "GET", `/api/customers/${doomed}/statement`);

  // dye purge cascade (impact first, then the purge with the typed confirmation)
  await step("dye.impact", "GET", `/api/inventory/dyes/${dye}/deletion-impact`);
  await step("dye.purge.wrong-confirmation", "DELETE", `/api/inventory/dyes/${dye}/purge`, { confirmation: "خطأ" });
  await step("dye.purge", "DELETE", `/api/inventory/dyes/${dye}/purge`, { confirmation: "تأكيد", reason: "اختبار" });
  await step("dye.after.fabrics", "GET", "/api/inventory/fabrics?limit=50");
  await step("dye.after.invoices", "GET", "/api/invoices?type=sale&limit=100");
  await step("dye.after.cashbox", "GET", "/api/cashbox/movements/2026-04-02?currency=SYP");
  await step("customer.list.after-purge", "GET", "/api/customers?limit=100");
}
