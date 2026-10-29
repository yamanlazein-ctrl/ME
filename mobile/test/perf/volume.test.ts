// T130 (NFR-02, NFR-03): the phone's queries over a database with 100,000 invoices, measured under Node (the real phone
// numbers are T131, owner-local). Skipped unless MOTARD_PERF=1: the seed alone writes ~300,000 rows.
//   MOTARD_PERF=1 npx vitest run test/perf/volume.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import { listParties } from "../../src/core/parties";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const ON = process.env.MOTARD_PERF === "1";
const PARTIES = 2_000;
const INVOICES = 100_000;

const results: Record<string, number | string> = {};
const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  const out = await fn();
  results[name] = Math.round(performance.now() - t0);
  return out;
};

describe.skipIf(!ON)("volume: 100,000 invoices (T130)", () => {
  let t: TestPhone;
  let deepParty = "";
  beforeAll(async () => {
    t = await makeTestPhone();
    const tenant = t.phone.identity.tenantId;
    const conn = t.conn;
    const stamp = "2026-01-01T00:00:00.000000Z";
    const t0 = performance.now();
    conn.exec("PRAGMA foreign_keys = OFF");
    conn.exec("BEGIN");
    const insParty = conn.prepare(
      "INSERT INTO parties (id, tenant_id, kind, code, name, currency, status, created_at, updated_at) VALUES (?, ?, 'customer', ?, ?, 'USD', 'active', ?, ?)",
    );
    const ids: string[] = [];
    for (let i = 0; i < PARTIES; i++) {
      const id = randomUUID();
      ids.push(id);
      insParty.run(
        id,
        tenant,
        `CUS-2026-${String(i + 1).padStart(5, "0")}`,
        `عميل ${i + 1}`,
        stamp,
        stamp,
      );
    }
    deepParty = ids[0]!;
    const insInv = conn.prepare(
      "INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, currency, subtotal, total, created_at, updated_at) VALUES (?, ?, ?, 'sale', ?, ?, 'customer', 'USD', ?, ?, ?, ?)",
    );
    const insLedger = conn.prepare(
      "INSERT INTO ledger_entries (id, tenant_id, party_id, date, type, debit, credit, currency, reference_type, reference_id, reference_number, created_at) VALUES (?, ?, ?, ?, 'sales_invoice', ?, 0, 'USD', 'invoice', ?, ?, ?)",
    );
    for (let i = 0; i < INVOICES; i++) {
      const id = randomUUID();
      // one deep customer holds 20% of the documents (the desktop volume seed's shape)
      const party = i % 5 === 0 ? deepParty : ids[1 + (i % (PARTIES - 1))]!;
      const day = `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`;
      const number = `INV-2026-${String(i + 1).padStart(6, "0")}`;
      const amount = 10000 + (i % 5000); // scaled x100
      insInv.run(id, tenant, number, day, party, amount, amount, stamp, stamp);
      insLedger.run(randomUUID(), tenant, party, day, amount, id, number, stamp);
    }
    conn.exec("COMMIT");
    conn.exec("PRAGMA foreign_keys = ON");
    results.seedMs = Math.round(performance.now() - t0);
  }, 600_000);

  afterAll(() => {
    results.invoices = INVOICES;
    results.parties = PARTIES;
    writeFileSync(
      new URL("../../../specs/002-mobile-app/evidence/T130.numbers.json", import.meta.url),
      JSON.stringify(results, null, 2),
    );
    t?.close();
  });

  it("party search answers in under a second", async () => {
    const rows = await time("partySearchMs", () =>
      listParties(t.phone, { q: "عميل 15", kind: "" }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(results.partySearchMs as number).toBeLessThan(1000);
  });

  it("the first page of the deepest customer's statement (20,000 documents) loads in under 2 seconds", async () => {
    const data = await time("firstStatementPageMs", () =>
      t.phone.repos.statementRepo.getStatement(
        { partyId: deepParty, kind: "customer", currency: "USD", limit: 200 } as never,
        t.phone.context(),
      ),
    );
    expect(data.entries).toHaveLength(200);
    expect(results.firstStatementPageMs as number).toBeLessThan(2000);
  });

  it("saving one invoice stays under 2 seconds", async () => {
    const ctx = t.phone.context();
    const fabric = await createFabricUseCase(
      t.phone.repos.fabricRepo,
      { name: "قطن حجم", minStockKg: 0 },
      ctx,
    );
    if (!fabric.ok) throw new Error(fabric.error);
    const color = await createColorUseCase(
      t.phone.repos.colorRepo,
      { fabricId: fabric.data.id, name: "أبيض" },
      ctx,
    );
    if (!color.ok) throw new Error(color.error);
    const roll = await createRollUseCase(
      t.phone.repos.rollRepo,
      {
        colorId: color.data.id,
        rollNo: "VOL-1",
        initialKg: 100,
        pieces: 1,
        pricePerKg: 3,
        currency: "USD",
        entryDate: "2026-01-01",
      },
      ctx,
    );
    if (!roll.ok) throw new Error(roll.error);
    const sale = await time("invoiceSaveMs", () =>
      t.phone.documents.createInvoice({
        type: "sale",
        date: "2026-03-01",
        partyId: deepParty,
        partyType: "customer",
        currency: "USD",
        exchangeRate: 1,
        lines: [
          {
            fabricId: fabric.data.id,
            colorId: color.data.id,
            rollId: roll.data.id,
            quantityKg: 5,
            pieces: 0,
            pricePerKg: 4,
          },
        ],
        paid: 0,
        preAllocatedNumber: "INV-2026-900001",
      } as never),
    );
    expect(sale.ok).toBe(true);
    expect(results.invoiceSaveMs as number).toBeLessThan(2000);
  });
});
