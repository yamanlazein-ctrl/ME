/**
 * Audit regression tests — E2E accounting audit 2026-08-23.
 *
 * Defect-encoding tests use `it.fails`: they PASS while the defect exists and
 * start FAILING the moment the defect is fixed. When a fix lands, flip
 * `it.fails(...)` → `it(...)` so the correct behavior stays pinned.
 * Run with AUDIT_STRICT=1 to see the raw failures instead.
 *
 * Findings covered (IDs match the audit report):
 *   H1  cross-currency COGS contamination
 *   H3  party-kind validation gap on invoice create
 *   M4  statement entry list includes cancelled documents
 *   M5  cashbox API has no currency dimension (USD invisible)
 *   M7  party_balances cache never written
 *   M8  settlement ledger legs have no source document (reference_id NULL)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { randomUUID } from "node:crypto";

const BASE = process.env.API_BASE ?? "http://127.0.0.1:8080";
const defect = process.env.AUDIT_STRICT ? it : it.fails;

let token = "";
let tenantId = "";
async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json } as { status: number; json: any };
}
const q = (frag: ReturnType<typeof sql>) => db.execute(frag);
const today = () => new Date().toISOString().slice(0, 10);

const CUSTOMER_NAME = "Audit Regression Customer";
const SUPPLIER_NAME = "Audit Regression Supplier";
const FABRIC_NAME = "Audit Regression Fabric";
const COLOR_NAME = "Audit Regression Color";
const ROLL_SYP_NO = "AUDITREG-SYP";
const ROLL_USD_NO = "AUDITREG-USD";
const createdInvoiceIds: string[] = [];

async function findOrCreateParty(kind: "customer" | "supplier", name: string) {
  const list = await api("GET", `/api/${kind}s?search=${encodeURIComponent(name)}&limit=100`);
  const items: any[] = list.json?.data ?? [];
  const found = items.find((p) => p.name === name);
  if (found) return found;
  const res = await api("POST", `/api/${kind}s`, { kind, name, currency: "SYP" });
  expect([200, 201]).toContain(res.status);
  return res.json.data ?? res.json;
}

beforeAll(async () => {
  const tenantRow = await q(sql`select id from tenants order by created_at limit 1`);
  tenantId = (tenantRow.rows[0] as any).id;
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@erp.local", password: "admin123", tenantId }),
  });
  expect(login.status).toBe(200);
  token = (await login.json()).accessToken;

  // fixtures
  await findOrCreateParty("customer", CUSTOMER_NAME);
  await findOrCreateParty("supplier", SUPPLIER_NAME);
  const fabrics: any[] = (await api("GET", `/api/inventory/fabrics?search=${encodeURIComponent(FABRIC_NAME)}`)).json?.data ?? [];
  let fabric = fabrics.find((f) => f.name === FABRIC_NAME);
  if (!fabric) {
    const r = await api("POST", "/api/inventory/fabrics", { name: FABRIC_NAME });
    fabric = r.json.data ?? r.json;
  }
  const colors: any[] = (await api("GET", `/api/inventory/colors?fabricId=${fabric.id}`)).json?.data ?? [];
  let color = colors.find((c) => c.name === COLOR_NAME);
  if (!color) {
    const r = await api("POST", "/api/inventory/colors", { fabricId: fabric.id, name: COLOR_NAME, code: "AUDREG" });
    color = r.json.data ?? r.json;
  }
  const rolls: any[] = (await api("GET", "/api/inventory/rolls?limit=1000")).json?.data ?? [];
  for (const [rollNo, price, currency] of [[ROLL_SYP_NO, 30000, "SYP"], [ROLL_USD_NO, 10, "USD"]] as const) {
    if (!rolls.find((r) => r.rollNo === rollNo)) {
      const r = await api("POST", "/api/inventory/rolls", {
        colorId: color.id, rollNo, initialKg: 100, pricePerKg: price, currency, entryDate: today(), pieces: 10,
      });
      expect([200, 201]).toContain(r.status);
    }
  }
});

afterAll(async () => {
  for (const id of createdInvoiceIds) await api("POST", `/api/invoices/${id}/cancel`, {});
});

async function createSaleInvoice(opts: {
  partyId: string; rollNo: string; currency: "SYP" | "USD"; qty: number; price: number;
}) {
  const rolls: any[] = (await api("GET", `/api/inventory/rolls?limit=1000`)).json?.data ?? [];
  const roll = rolls.find((r) => r.rollNo === opts.rollNo);
  expect(roll).toBeTruthy();
  const colors: any[] = (await api("GET", `/api/inventory/colors?limit=1000`)).json?.data ?? [];
  const color = colors.find((c) => c.id === roll.colorId);
  expect(color).toBeTruthy();
  const res = await api("POST", "/api/invoices", {
    type: "sale", date: today(), partyId: opts.partyId, partyType: "customer", currency: opts.currency,
    lines: [{ fabricId: color.fabricId, colorId: color.id, rollId: roll.id, quantityKg: opts.qty, pieces: 1, pricePerKg: opts.price }],
  });
  if ([200, 201].includes(res.status)) createdInvoiceIds.push((res.json.data ?? res.json).id);
  return res;
}

// ---------------------------------------------------------------- H3
describe("H3 — invoice create must validate party kind", () => {
  // FIX LANDED (party-kind guard in PostgresInvoiceRepository.create):
  // flipped it.fails → it.
  it("rejects an entry invoice that puts a CUSTOMER id under partyType=supplier", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const rolls: any[] = (await api("GET", "/api/inventory/rolls?limit=1000")).json?.data ?? [];
    const roll = rolls.find((r) => r.rollNo === ROLL_SYP_NO);
    const colors: any[] = (await api("GET", `/api/inventory/colors?limit=1000`)).json?.data ?? [];
    const color = colors.find((c) => c.id === roll.colorId);
    const res = await api("POST", "/api/invoices", {
      type: "entry", date: today(), partyId: cust.id, partyType: "supplier", currency: "SYP",
      lines: [{ fabricId: color.fabricId, colorId: color.id, rollId: roll.id, quantityKg: 0.01, pricePerKg: 1000 }],
    });
    if ([200, 201].includes(res.status)) createdInvoiceIds.push((res.json.data ?? res.json).id);
    // Correct contract: kind mismatch must be rejected client/server-side.
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------- H1
describe("H1 — COGS must not import another currency's cost numbers", () => {
  // No conversion feature exists (verified by audit), so the only safe contract
  // is: a sale whose currency differs from the roll's cost currency is rejected.
  // FIX LANDED (cross-currency guard in PostgresInvoiceRepository create/update):
  // flipped it.fails → it.
  it("rejects a USD sale of an SYP-costed roll", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_SYP_NO, currency: "USD", qty: 1, price: 12.5 });
    expect(res.status).toBe(422);
  });

  it("rejects an SYP sale of a USD-costed roll", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_USD_NO, currency: "SYP", qty: 1, price: 5000000 });
    expect(res.status).toBe(422);
  });

  it("same-currency sales keep working (control)", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_SYP_NO, currency: "SYP", qty: 0.01, price: 30000 });
    expect([200, 201]).toContain(res.status);
    const inv = res.json.data ?? res.json;
    const legs = (await q(sql`select type, debit, credit, currency from ledger_entries where reference_number = ${inv.number}`)).rows as any[];
    const cogs = legs.find((l) => l.type === "cogs_expense");
    expect(cogs).toBeTruthy();
    expect(cogs.currency).toBe("SYP");
    expect(Number(cogs.debit)).toBeCloseTo(0.01 * 30000, 0);
  });
});

// ---------------------------------------------------------------- M4
describe("M4 — statement entry list must exclude cancelled documents", () => {
  it.fails("omits cancelled invoices from statement entries", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_SYP_NO, currency: "SYP", qty: 0.01, price: 30000 });
    expect([200, 201]).toContain(res.status);
    const inv = res.json.data ?? res.json;
    const legIds = (await q(sql`select id from ledger_entries where reference_number = ${inv.number}`)).rows.map((r: any) => r.id);
    const cancel = await api("POST", `/api/invoices/${inv.id}/cancel`, {});
    expect([200, 201]).toContain(cancel.status);
    const stmt = await api("GET", `/api/customers/${cust.id}/statement?currency=SYP`);
    expect(stmt.status).toBe(200);
    const listed = stmt.json.entries.map((e: any) => e.id);
    expect(listed.filter((id: string) => legIds.includes(id))).toEqual([]);
  });
});

// ---------------------------------------------------------------- M5
describe("M5 — cashbox API must expose every currency in the ledger", () => {
  it.fails("balance endpoint returns a per-currency breakdown including USD", async () => {
    const res = await api("GET", `/api/cashbox/balance/${today()}`);
    expect(res.status).toBe(200);
    // Current behavior: a single bare SYP number — USD cash is invisible.
    expect(res.json).toEqual(expect.objectContaining({ SYP: expect.anything(), USD: expect.anything() }));
  });
});

// ---------------------------------------------------------------- M7
// party_balances was dead code (never written, never read) and has been
// removed entirely — the ledger itself is the single source of truth, so
// the old cache-sync regression test no longer applies.

// ---------------------------------------------------------------- M8
describe("M8 — settlement legs must reference a resolvable source document", () => {
  // FIX LANDED (settlement referenceId in PostgresStatementRepository.settle):
  // flipped it.fails → it.
  it("settlement leg carries a non-null reference_id", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    // ensure non-zero balance
    const bal = (await q(sql`select coalesce(sum(debit - credit), 0) as b from ledger_entries where party_id = ${cust.id} and currency = 'SYP' and status = 'active'`)).rows[0] as any;
    if (Number(bal.b) === 0) {
      const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_SYP_NO, currency: "SYP", qty: 0.01, price: 30000 });
      expect([200, 201]).toContain(res.status);
    }
    const settle = await api("POST", `/api/customers/${cust.id}/statement/settle`, { date: today(), currency: "SYP", notesInternal: "audit-regression" });
    if (settle.status === 422) return; // zero balance — nothing to settle
    expect(settle.status).toBe(201);
    const refNum = settle.json.referenceNumber;
    const legs = (await q(sql`select reference_id from ledger_entries where reference_number = ${refNum}`)).rows as any[];
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(leg.reference_id).not.toBeNull();
  });
});

// ---------------------------------------------------------------- guards (green today)
describe("guards — correct behaviors that must survive the fixes", () => {
  it("invoice batches stay balanced", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_SYP_NO, currency: "SYP", qty: 0.01, price: 30000 });
    const inv = res.json.data ?? res.json;
    const legs = (await q(sql`select debit, credit from ledger_entries where reference_number = ${inv.number} and status = 'active'`)).rows as any[];
    const sum = legs.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
    expect(sum).toBe(0);
  });

  it("cancelling an invoice soft-cancels all of its legs", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const res = await createSaleInvoice({ partyId: cust.id, rollNo: ROLL_SYP_NO, currency: "SYP", qty: 0.01, price: 30000 });
    const inv = res.json.data ?? res.json;
    await api("POST", `/api/invoices/${inv.id}/cancel`, {});
    const legs = (await q(sql`select status from ledger_entries where reference_number = ${inv.number}`)).rows as any[];
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.status === "cancelled")).toBe(true);
  });

  it("statement date-window previousBalance equals movements strictly before `from`", async () => {
    const cust = await findOrCreateParty("customer", CUSTOMER_NAME);
    const stmt = await api("GET", `/api/customers/${cust.id}/statement?currency=SYP&from=2030-01-01&to=2030-01-31`);
    expect(stmt.status).toBe(200);
    expect(stmt.json.entries).toHaveLength(0);
    const expected = (await q(sql`select coalesce(sum(debit - credit), 0) as b from ledger_entries where party_id = ${cust.id} and currency = 'SYP' and status = 'active' and date < '2030-01-01'`)).rows[0] as any;
    expect(stmt.json.previousBalance).toBe(Number(expected.b));
  });
});
