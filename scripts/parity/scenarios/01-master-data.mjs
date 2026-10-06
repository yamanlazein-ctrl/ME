/** Parties, fabrics, colours, rolls (master data) — the base every later scenario uses. */
export default async function masterData({ step, state }) {
  const c1 = await step("customer.create.plain", "POST", "/api/customers", { kind: "customer", name: "أحمد التاجر", phone: "0933000001", city: "دمشق" });
  const c2 = await step("customer.create.opening-debit", "POST", "/api/customers", {
    kind: "customer",
    name: "Beta Textiles",
    code: "C-BETA",
    openingAmount: 1250000.55,
    openingDirection: "they_owe_us",
  });
  const c3 = await step("customer.create.unicode", "POST", "/api/customers", { kind: "customer", name: "إيلاف للأقمشة", email: " ilaf@example.com " });
  const s1 = await step("supplier.create.plain", "POST", "/api/suppliers", { kind: "supplier", name: "معمل النسيج الحديث", phone: "0944000001" });
  const s2 = await step("supplier.create.opening", "POST", "/api/suppliers", { kind: "supplier", name: "Gamma Yarn", openingBalance: 830.4 });
  state.customers = [c1, c2, c3].map(idOf);
  state.suppliers = [s1, s2].map(idOf);

  const cur = await step("customer.get.before-update", "GET", `/api/customers/${state.customers[0]}`);
  await step("customer.update", "PUT", `/api/customers/${state.customers[0]}`, { phone: "0933000002", city: "حلب", expectedVersion: cur?.version ?? cur?.data?.version });
  await step("customer.list", "GET", "/api/customers?limit=50");
  await step("supplier.list", "GET", "/api/suppliers?limit=50");
  await step("customer.get", "GET", `/api/customers/${state.customers[1]}`);

  const f1 = await step("fabric.create.1", "POST", "/api/inventory/fabrics", { name: "قطن مصري", category: "قطن", minStockKg: 10 });
  const f2 = await step("fabric.create.2", "POST", "/api/inventory/fabrics", { name: "Polyester 150D", unit: "kg" });
  state.fabrics = [f1, f2].map(idOf);
  const col = [];
  for (const [i, [fi, name, hex]] of [
    [0, "أبيض", "#ffffff"],
    [0, "كحلي", "#000080"],
    [1, "Black", "#000000"],
  ].entries()) {
    col.push(idOf(await step(`color.create.${i}`, "POST", "/api/inventory/colors", { fabricId: state.fabrics[fi], name, hex, code: `CL-${i}` })));
  }
  state.colors = col;
  await step("fabric.list", "GET", "/api/inventory/fabrics?limit=50");
  await step("color.list", "GET", `/api/inventory/colors?fabricId=${state.fabrics[0]}&limit=50`);

  // Rolls registered empty; the entry invoices in 02 bring the stock in.
  const rolls = [];
  const specs = [
    [0, "R-001", 120.5, 18500.25, "SYP"],
    [1, "R-002", 98.75, 21000, "SYP"],
    [2, "R-003", 60.33, 3.4567, "USD"],
    [0, "R-004", 45, 19000, "SYP"],
  ];
  for (const [i, [ci, rollNo, kg, price, currency]] of specs.entries()) {
    const r = await step(`roll.create.${i}`, "POST", "/api/inventory/rolls", {
      colorId: state.colors[ci],
      rollNo,
      initialKg: kg,
      remainingKg: 0,
      pricePerKg: price,
      currency,
      supplierId: state.suppliers[0],
      entryDate: "2026-02-01",
      pieces: 2,
    });
    rolls.push(idOf(r));
  }
  state.rolls = rolls;
  state.rollColor = specs.map(([ci]) => ci);
}

export function idOf(body) {
  const id = body?.id ?? body?.data?.id;
  if (!id) throw new Error(`no id in response: ${JSON.stringify(body).slice(0, 200)}`);
  return id;
}
