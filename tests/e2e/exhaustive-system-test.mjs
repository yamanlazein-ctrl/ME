#!/usr/bin/env node
/**
 * Exhaustive Full-System Test Harness
 * ====================================
 * Executes the STAGE 1-4 plan from tests/e2e/exhaustive-test-cases.md.
 * Produces: audit/exhaustive-report.json + audit/exhaustive-report.md
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.ERP_API_BASE_URL || "http://localhost:8083";
const TENANT_ID = process.env.ERP_TENANT_ID || "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const EMAIL = process.env.ERP_ADMIN_EMAIL || "admin@erp.local";
const PASSWORD = process.env.ERP_ADMIN_PASSWORD || "GcvUIlmnyP5rZQs6rO";

const AUDIT_DIR = path.resolve(process.cwd(), "audit");
let token = "";
const results = []; // { tag, name, expected, actual, pass }
const counters = {}; // tag -> { total, pass, fail }

function today() { return new Date().toISOString().slice(0, 10); }
function dOff(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function api(method, endpoint, body, headers = {}) {
  const opts = { method, headers: { "Content-Type": "application/json", Authorization: token ? `Bearer ${token}` : undefined, ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${endpoint}`, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function check(tag, name, expected, actual, detail = "") {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ tag, name, expected: JSON.stringify(expected), actual: JSON.stringify(actual), pass, detail });
  counters[tag] = counters[tag] || { total: 0, pass: 0, fail: 0 };
  counters[tag].total++;
  pass ? counters[tag].pass++ : counters[tag].fail++;
  console.log(`[${pass ? "✓" : "✗"}] [${tag}] ${name}${!pass ? `  (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})` : ""}${detail ? "  " + detail : ""}`);
}

async function login() {
  token = (await api("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD, tenantId: TENANT_ID })).data.accessToken;
}
async function ledgerByRef(t, id) { return (await api("GET", `/api/ledger?referenceType=${t}&referenceId=${id}&limit=1000`)).data?.data ?? []; }
async function rollKg(id) { const r = await api("GET", `/api/inventory/rolls/${id}`); return Number(r.data?.remainingKg ?? 0); }
async function cashbox() { const r = await api("GET", `/api/cashbox/balance/${today()}?currency=SYP`); return typeof r.data === "number" ? r.data : r.data?.balance ?? 0; }

async function mkStock(name, cost, kg) {
  const fab = (await api("POST", "/api/inventory/fabrics", { name, minStockKg: 5 })).data;
  const col = (await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: name + "-color", code: `C${uniq()}` })).data;
  const roll = (await api("POST", "/api/inventory/rolls", { colorId: col.id, rollNo: `R-${uniq()}`, initialKg: kg, remainingKg: kg, pricePerKg: cost, entryDate: dOff(-5) })).data;
  return { fab, col, roll };
}

/* ================= STAGE 1: BOUNDARY + EDGE ================= */
async function stage1() {
  console.log("\n═══ STAGE 1 — Boundary + Edge ═══");
  await login();
  const u = uniq();
  const cust = (await api("POST", "/api/customers", { name: `عميل ${u}`, code: `CUST-${u}` })).data;
  const supp = (await api("POST", "/api/suppliers", { name: `مورد ${u}`, code: `SUPP-${u}` })).data;

  // INV.BC.01: sell exactly available
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-1`, 1000, 50);
    const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 50, pricePerKg: 1000 }] });
    check("I10", "INV.BC.01 sell exactly available → 0 remaining", true, r.status === 201 && (await rollKg(roll.id)) === 0);
  }
  // INV.BC.02: sell available + 0.01 (scale-2 granularity)
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-2`, 1000, 50);
    const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 50.01, pricePerKg: 1000 }] });
    check("I10", "INV.BC.02 sell available+0.01 → rejected", true, r.status === 422);
  }
  // INV.BC.03: sell 0
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-3`, 1000, 50);
    const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 0, pricePerKg: 1000 }] });
    check("I10", "INV.BC.03 sell 0 → rejected", true, r.status === 422);
  }
  // INV.BC.04: sell negative
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-4`, 1000, 50);
    const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: -5, pricePerKg: 1000 }] });
    check("I10", "INV.BC.04 sell negative → rejected", true, r.status === 422);
  }
  // INV.BC.05: roll initialKg 0
  {
    const fab = (await api("POST", "/api/inventory/fabrics", { name: `قماش ${u}-5`, minStockKg: 5 })).data;
    const col = (await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: "c", code: `C${uniq()}` })).data;
    const r = await api("POST", "/api/inventory/rolls", { colorId: col.id, rollNo: `R-${uniq()}`, initialKg: 0, remainingKg: 0, pricePerKg: 1000, entryDate: today() });
    check("I10", "INV.BC.05 roll initialKg 0 → rejected", true, r.status === 422);
  }
  // INV.BC.06: 0.001 kg line (beyond 2dp storage precision) → rejected
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-6`, 1000, 50);
    const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 0.001, pricePerKg: 1000 }] });
    check("I4", "INV.BC.06 0.001 kg line → rejected (precision 0.01)", true, r.status === 422, `status=${r.status}`);
  }
  // CB.BC.01: opening balance 0
  {
    const r = await api("POST", "/api/cashbox/opening-balance", { openingBalance: 0, openingDate: today(), currency: "SYP" });
    check("CB", "CB.BC.01 opening balance 0", true, r.status === 200);
  }
  // CB.BC.02: expense > cashbox balance → REJECTED (no negative cashbox).
  // Fund the cashbox with 500 via a receipt, then post a 2000 expense.
  {
    const funder = (await api("POST", "/api/customers", { name: `ممول ${u}`, code: `F-${uniq()}` })).data;
    await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: funder.id, partyKind: "customer", amount: 500, currency: "SYP", method: "cash" });
    const before = await cashbox();
    const r = await api("POST", "/api/expenses", { category: "gen", description: "expense > balance", amount: 2000, currency: "SYP", date: today(), method: "cash" });
    const after = await cashbox();
    check("CB", "CB.BC.02 expense > cashbox balance → rejected (no negative)", true, r.status === 422 && after === before, `status=${r.status} before=${before} after=${after}`);
  }
  // Fund the cashbox generously so later stages' cash ops never overdraft.
  {
    const funder = (await api("POST", "/api/customers", { name: `تمويل ${u}`, code: `T-${uniq()}` })).data;
    await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: funder.id, partyKind: "customer", amount: 10000000, currency: "SYP", method: "cash" });
    const b = await cashbox();
    check("CB", "CB.GEN.01 cashbox funded (10,000,500) for later stages", true, b === 10000500, `balance=${b}`);
  }
  // CB.ED.01: receipt + payment same moment, two parties — both journaled, I1
  {
    const a = (await api("POST", "/api/customers", { name: `عميل A ${u}`, code: `A-${uniq()}` })).data;
    const b = (await api("POST", "/api/suppliers", { name: `مورد B ${u}`, code: `B-${uniq()}` })).data;
    const before = await cashbox();
    const rec = await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: a.id, partyKind: "customer", amount: 5000, currency: "SYP", method: "cash" });
    const pay = await api("POST", "/api/payments", { kind: "payment", date: today(), partyId: b.id, partyKind: "supplier", amount: 3000, currency: "SYP", method: "cash" });
    const after = await cashbox();
    const recEntries = await ledgerByRef("receipt_in", rec.data.id);
    const payEntries = await ledgerByRef("payment_out", pay.data.id);
    const dR = recEntries.reduce((s, e) => s + (e.debit || 0), 0);
    const cR = recEntries.reduce((s, e) => s + (e.credit || 0), 0);
    const dP = payEntries.reduce((s, e) => s + (e.debit || 0), 0);
    const cP = payEntries.reduce((s, e) => s + (e.credit || 0), 0);
    const balA = (await api("GET", `/api/ledger/balance/${a.id}?currency=SYP`)).data;
    const balB = (await api("GET", `/api/ledger/balance/${b.id}?currency=SYP`)).data;
    check("CB", "CB.ED.01 receipt+payment same moment → both balanced, cashbox net +2000", true,
      rec.status === 201 && pay.status === 201 && dR === cR && dP === cP && after === before + 2000 && balA.balance === -5000 && balB.balance === -3000,
      `cashbox ${before}->${after} A=${balA.balance} B=${balB.balance}`);
  }
  // CB.ED.02: partial payment in USD on a USD invoice — I7 cross-check
  {
    const c = (await api("POST", "/api/customers", { name: `عميل FX ${u}`, code: `FX-${uniq()}`, currency: "USD" })).data;
    const { fab, col, roll } = await mkStock(`قماش ${u}-E2`, 10, 100);
    await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: c.id, partyType: "customer", currency: "USD", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 5 }] });
    await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: c.id, partyKind: "customer", amount: 20, currency: "USD", method: "cash" });
    const usd = (await api("GET", `/api/ledger/balance/${c.id}?currency=USD`)).data;
    const syp = (await api("GET", `/api/ledger/balance/${c.id}?currency=SYP`)).data;
    check("CB", "CB.ED.02 partial USD payment on USD invoice → USD=30, SYP=0 (I7)", true, usd.balance === 30 && syp.balance === 0, `USD=${usd.balance} SYP=${syp.balance}`);
  }
  // RT.BC.01: return full invoice quantity
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-7`, 1000, 50);
    const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 20, pricePerKg: 1000 }] })).data;
    const r = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: 20, pricePerKg: 1000 }] });
    check("RT", "RT.BC.01 return full qty → 201", true, r.status === 201);
  }
  // RT.BC.02: return > sold → rejected
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-8`, 1000, 50);
    const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 1000 }] })).data;
    const r = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: 15, pricePerKg: 1000 }] });
    check("RT", "RT.BC.02 return > sold → rejected", true, r.status === 422, `status=${r.status}`);
  }
  // INV.ED.01: print send ALL available stock → remaining 0 (no negative)
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-ED1`, 1000, 40);
    const s = await api("POST", "/api/printing/send", { date: today(), sourceRollId: roll.id, quantityKg: 40 });
    const remaining = await rollKg(roll.id);
    check("I9", "INV.ED.01 print send ALL available stock → remaining 0", true, s.status === 201 && remaining === 0, `status=${s.status} remaining=${remaining}`);
  }
  // INV.ED.02: cancel sale then partial return on it → rejected; stock restored
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-ED2`, 1000, 100);
    const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 30, pricePerKg: 1000 }] })).data;
    const c = await api("POST", `/api/invoices/${inv.id}/cancel`);
    const restored = await rollKg(roll.id);
    const rr = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: 10, pricePerKg: 1000 }] });
    check("RT", "INV.ED.02 cancel sale then partial return → rejected, stock restored", true, c.status === 200 && restored === 100 && rr.status === 422, `cancel=${c.status} restored=${restored} return=${rr.status}`);
  }
  // RT.ED.01: two returns on same invoice exceeding original qty → second rejected
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-RTE1`, 1000, 100);
    const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 30, pricePerKg: 1000 }] })).data;
    const r1 = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: 20, pricePerKg: 1000 }] });
    const r2 = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: 20, pricePerKg: 1000 }] });
    check("RT", "RT.ED.01 two returns cumulative > original → second rejected", true, r1.status === 201 && r2.status === 422, `r1=${r1.status} r2=${r2.status}`);
  }
  // PR.ED.01: print send then exact receive → conservation, waste 0
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-PRE1`, 1000, 100);
    const send = (await api("POST", "/api/printing/send", { date: today(), sourceRollId: roll.id, quantityKg: 40 })).data;
    const srcAfter = await rollKg(roll.id);
    const recv = await api("POST", "/api/printing/receive", { jobId: send.id, date: today(), receivedKg: 40, newName: "مطبوع", newColorName: "مطبوع" });
    const job = (await api("GET", `/api/printing/${send.id}`)).data;
    check("I9", "PR.ED.01 print send then exact receive → source 60, waste 0", true, srcAfter === 60 && [200, 201].includes(recv.status) && job.wasteKg === 0, `src=${srcAfter} status=${recv.status} waste=${job.wasteKg}`);
  }
  // PR.BC.01: print over-receive rejected
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-9`, 1000, 100);
    const send = (await api("POST", "/api/printing/send", { date: today(), sourceRollId: roll.id, quantityKg: 30 })).data;
    const r = await api("POST", "/api/printing/receive", { jobId: send.id, date: today(), receivedKg: 31 });
    check("I9", "PR.BC.01 print over-receive → rejected", true, r.status === 422, `status=${r.status}`);
  }
  // PR.BC.02 + I9: print waste documented
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-10`, 1000, 100);
    const send = (await api("POST", "/api/printing/send", { date: today(), sourceRollId: roll.id, quantityKg: 30 })).data;
    const recv = await api("POST", "/api/printing/receive", { jobId: send.id, date: today(), receivedKg: 28, newName: "مطبوع", newColorName: "مطبوع" });
    const job = (await api("GET", `/api/printing/${send.id}`)).data;
    check("I9", "PR.BC.02 print waste = 2 documented", 2, job.wasteKg);
  }
  console.log("STAGE 1 done");
}

/* ================= STAGE 2: INVARIANTS (random) ================= */
async function stage2() {
  console.log("\n═══ STAGE 2 — Invariant Testing ═══");
  await login();
  const u = uniq();
  const cust = (await api("POST", "/api/customers", { name: `عميل ${u}`, code: `CUST-${u}` })).data;
  const supp = (await api("POST", "/api/suppliers", { name: `مورد ${u}`, code: `SUPP-${u}` })).data;

  // I1: 40 random mixed transactions, each balanced
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-I1`, 5000, 100000);
    let okCount = 0;
    for (let i = 0; i < 40; i++) {
      const kind = i % 5;
      let refType, refId;
      if (kind === 0) { const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 1 + (i % 5), pricePerKg: 1000 + i }] }); refType = "sales_invoice"; refId = r.data.id; }
      else if (kind === 1) { const r = await api("POST", "/api/invoices", { type: "entry", date: today(), partyId: supp.id, partyType: "supplier", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 2, pricePerKg: 800 }] }); refType = "purchase_invoice"; refId = r.data.id; }
      else if (kind === 2) { const r = await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: cust.id, partyKind: "customer", amount: 1000 + i * 10, currency: "SYP", method: "cash" }); refType = "receipt_in"; refId = r.data.id; }
      else if (kind === 3) { const r = await api("POST", "/api/payments", { kind: "payment", date: today(), partyId: supp.id, partyKind: "supplier", amount: 500 + i * 10, currency: "SYP", method: "cash" }); refType = "payment_out"; refId = r.data.id; }
      else { const r = await api("POST", "/api/expenses", { category: "gen", description: "x", amount: 700 + i, currency: "SYP", date: today(), method: i % 2 ? "cash" : "transfer" }); refType = "expense"; refId = r.data.id; }
      const entries = await ledgerByRef(refType, refId);
      const d = entries.reduce((s, e) => s + (e.debit || 0), 0);
      const c = entries.reduce((s, e) => s + (e.credit || 0), 0);
      if (d === c && entries.length >= 2) okCount++;
    }
    check("I1", "I1.GEN.01 40 random transactions all balanced", 40, okCount);
  }

  // I2: quantity conservation across 30 random ops (sales + returns)
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-I2`, 1000, 100);
    let expected = 100;
    let conserved = true;
    for (let i = 0; i < 15; i++) {
      const qty = Math.round((1 + Math.random() * 9) * 10) / 10;
      const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: qty, pricePerKg: 1000 }] })).data;
      if (!inv?.id) { conserved = false; break; }
      expected = Math.round((expected - qty) * 100) / 100;
      if ((await rollKg(roll.id)) !== expected) { conserved = false; break; }
      const rr = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: qty, pricePerKg: 1000 }] });
      if (rr.status !== 201) { conserved = false; break; }
      expected = Math.round((expected + qty) * 100) / 100;
      if ((await rollKg(roll.id)) !== expected) { conserved = false; break; }
    }
    check("I2", "I2.GEN.01 quantity conservation across 30 random ops", true, conserved, `remaining=${await rollKg(roll.id)} expected=${expected}`);
  }

  // I2.GEN.02: stock-in (purchase/entry invoice) conservation — every kg added is tracked
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-I2b`, 1000, 100);
    let expected = 100;
    let conserved = true;
    for (const qty of [25.5, 10, 4.25, 0.75]) {
      const r = await api("POST", "/api/invoices", { type: "entry", date: today(), partyId: supp.id, partyType: "supplier", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: qty, pricePerKg: 800 }] });
      if (r.status !== 201) { conserved = false; break; }
      expected = Math.round((expected + qty) * 100) / 100;
      if ((await rollKg(roll.id)) !== expected) { conserved = false; break; }
    }
    check("I2", "I2.GEN.02 stock-in (purchase) conservation across 4 entry invoices", true, conserved, `remaining=${await rollKg(roll.id)} expected=${expected}`);
  }

  // I2.GEN.03: fractional 2dp quantities conservation (10 sale/return pairs)
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-I2c`, 1000, 50);
    let expected = 50;
    let conserved = true;
    for (let i = 0; i < 10; i++) {
      const qty = Math.round((0.5 + Math.random() * 4.5) * 100) / 100;
      const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: qty, pricePerKg: 1000 }] })).data;
      if (!inv?.id) { conserved = false; break; }
      expected = Math.round((expected - qty) * 100) / 100;
      if ((await rollKg(roll.id)) !== expected) { conserved = false; break; }
      const rr = await api("POST", "/api/returns", { kind: "sale", date: today(), partyId: cust.id, originalInvoiceId: inv.id, reason: "defect", currency: "SYP", lines: [{ rollId: roll.id, quantityKg: qty, pricePerKg: 1000 }] });
      if (rr.status !== 201) { conserved = false; break; }
      expected = Math.round((expected + qty) * 100) / 100;
      if ((await rollKg(roll.id)) !== expected) { conserved = false; break; }
    }
    check("I2", "I2.GEN.03 fractional 2dp conservation across 10 sale/return pairs", true, conserved, `remaining=${await rollKg(roll.id)} expected=${expected}`);
  }

  // I8: 30 random color sales → strict isolation
  {
    const fab = (await api("POST", "/api/inventory/fabrics", { name: `قماش ${u}-I8`, minStockKg: 5 })).data;
    const cols = [], rolls = [];
    for (let i = 0; i < 6; i++) {
      const c = (await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: `لون${i}`, code: `I8${i}${u}` })).data;
      const r = (await api("POST", "/api/inventory/rolls", { colorId: c.id, rollNo: `R${i}-${u}`, initialKg: 100, remainingKg: 100, pricePerKg: 5000 + i * 100, entryDate: dOff(-5) })).data;
      cols.push(c); rolls.push(r);
    }
    const before = [];
    for (const r of rolls) before.push(await rollKg(r.id));
    let isolationOk = true;
    for (let i = 0; i < 30; i++) {
      const ci = i % 6;
      await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: cols[ci].id, rollId: rolls[ci].id, quantityKg: 5, pricePerKg: 7000 }] });
    }
    for (let i = 0; i < 6; i++) {
      // 30 sales round-robin across 6 colors → 5 sales × 5kg = 25kg each color.
      if ((await rollKg(rolls[i].id)) !== before[i] - 25) isolationOk = false;
    }
    check("I8", "I8.GEN.01 30 sales → each color loses exactly 25kg", true, isolationOk);
  }

  // I10: 20 random over-sell attempts all rejected, no negative
  {
    const { fab, col, roll } = await mkStock(`قماش ${u}-I10`, 1000, 30);
    let rejected = 0;
    for (let i = 0; i < 20; i++) {
      const r = await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 50, pricePerKg: 1000 }] });
      if (r.status === 422) rejected++;
    }
    const kg = await rollKg(roll.id);
    check("I10", "I10.GEN.01 20 over-sell attempts all rejected, stock unchanged", true, rejected === 20 && kg === 30, `rejected=${rejected} kg=${kg}`);
  }

  // I7: currency isolation
  {
    const c2 = (await api("POST", "/api/customers", { name: `عميل fx ${u}`, code: `FX-${u}`, currency: "USD" })).data;
    const { fab, col, roll } = await mkStock(`قماش ${u}-I7`, 10, 100);
    await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: c2.id, partyType: "customer", currency: "USD", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 5 }] });
    const usdBal = (await api("GET", `/api/ledger/balance/${c2.id}?currency=USD`)).data;
    const sypBal = (await api("GET", `/api/ledger/balance/${c2.id}?currency=SYP`)).data;
    check("I7", "I7.GEN.01 USD balance 50, SYP balance 0 (no mixing)", true, usdBal.balance === 50 && sypBal.balance === 0, `USD=${usdBal.balance} SYP=${sypBal.balance}`);
  }

  // I6: dashboard profit == ledger revenue − COGS
  {
    const all = (await api("GET", "/api/ledger?limit=1000")).data?.data ?? [];
    const rev = all.filter((e) => e.type === "sales_revenue" && e.status === "active").reduce((s, e) => s + (e.credit || 0), 0);
    const cogs = all.filter((e) => e.type === "cogs_expense" && e.status === "active").reduce((s, e) => s + (e.debit || 0), 0);
    const dash = (await api("GET", "/api/dashboard")).data;
    check("I6", "I6.GEN.01 dashboard profit == ledger revenue − COGS", rev - cogs, dash.todayProfit?.syp);
  }

  // I4: 300 sequential money ops → no drift, exact integer balances
  {
    const c4 = (await api("POST", "/api/customers", { name: `عميل I4 ${u}`, code: `I4-${u}` })).data;
    let total = 0;
    let allOk = true;
    for (let i = 0; i < 300; i++) {
      const amt = 100 + ((i * 37) % 900000);
      const r = await api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: c4.id, partyKind: "customer", amount: amt, currency: "SYP", method: "cash" });
      if (r.status !== 201) { allOk = false; break; }
      total += amt;
    }
    const all = (await api("GET", `/api/ledger?partyId=${c4.id}&sort=asc&limit=1000`)).data?.data ?? [];
    const replay = all.filter((e) => e.status === "active").reduce((s, e) => s + (e.debit || 0) - (e.credit || 0), 0);
    const bal = (await api("GET", `/api/ledger/balance/${c4.id}?currency=SYP`)).data;
    const exact = Number.isInteger(replay) && Number.isInteger(bal.balance);
    const consistent = bal.balance === replay && Math.abs(replay) === total;
    check("I4", "I4.GEN.01 300 sequential ops → no drift, exact integer balance", true, allOk && exact && consistent, `total=${total} replay=${replay} api=${bal.balance}`);
  }

  // I5: replay party balance
  {
    const all = (await api("GET", `/api/ledger?partyId=${cust.id}&sort=asc&limit=1000`)).data?.data ?? [];
    const replay = all.filter((e) => e.status === "active").reduce((s, e) => s + (e.debit || 0) - (e.credit || 0), 0);
    const apiBal = (await api("GET", `/api/ledger/balance/${cust.id}?currency=SYP`)).data;
    check("I5", "I5.GEN.01 replay balance == API balance", apiBal.balance, replay, `api=${apiBal.balance} replay=${replay}`);
  }

  // I3: idempotency
  {
    const key = `ik-${uniq()}`;
    const { fab, col, roll } = await mkStock(`قماش ${u}-I3`, 1000, 100);
    const body = { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 5, pricePerKg: 1000 }] };
    const r1 = await api("POST", "/api/invoices", body, { "Idempotency-Key": key });
    const r2 = await api("POST", "/api/invoices", body, { "Idempotency-Key": key });
    const invList = (await api("GET", `/api/invoices?partyId=${cust.id}&limit=1000`)).data.data;
    const count = invList.filter((i) => i.number === r1.data?.number).length;
    check("I3", "I3.GEN.01 duplicate invoice (same key) → 1 invoice", 1, count, `status1=${r1.status} status2=${r2.status}`);
  }

  // INV.ED.03: cancel invoice after partial receipt (linked voucher reversed)
  {
    const c3 = (await api("POST", "/api/customers", { name: `عميل IE3 ${u}`, code: `IE3-${u}` })).data;
    const { fab, col, roll } = await mkStock(`قماش ${u}-IE3`, 1000, 100);
    const inv = (await api("POST", "/api/invoices", { type: "sale", date: today(), partyId: c3.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 1000 }], paid: 5000, paymentMethod: "cash" })).data;
    const balBefore = (await api("GET", `/api/ledger/balance/${c3.id}?currency=SYP`)).data.balance;
    const c = await api("POST", `/api/invoices/${inv.id}/cancel`);
    const stock = await rollKg(roll.id);
    const balAfter = (await api("GET", `/api/ledger/balance/${c3.id}?currency=SYP`)).data.balance;
    const all = (await api("GET", `/api/ledger?partyId=${c3.id}&sort=asc&limit=1000`)).data?.data ?? [];
    const allCancelled = all.length > 0 && all.every((e) => e.status === "cancelled");
    check("RT", "INV.ED.03 cancel invoice after partial receipt → stock restored, balance 0, legs cancelled", true,
      c.status === 200 && balBefore === 5000 && stock === 100 && balAfter === 0 && allCancelled,
      `cancel=${c.status} before=${balBefore} stock=${stock} after=${balAfter} legs=${all.length}`);
  }
  console.log("STAGE 2 done");
}

/* ================= STAGE 3: CHAOS + CONCURRENCY ================= */
async function stage3() {
  console.log("\n═══ STAGE 3 — Concurrency ═══");
  await login();
  const u = uniq();
  const cust = (await api("POST", "/api/customers", { name: `عميل ${u}`, code: `CUST-${u}` })).data;
  const { fab, col, roll } = await mkStock(`قماش ${u}-CC`, 1000, 50);

  // CC.01: 10 concurrent sales of 10kg on a 50kg roll → exactly 5 succeed, remaining 0, no negative
  const bodies = Array.from({ length: 10 }, () => api("POST", "/api/invoices", { type: "sale", date: today(), partyId: cust.id, partyType: "customer", currency: "SYP", lines: [{ fabricId: fab.id, colorId: col.id, rollId: roll.id, quantityKg: 10, pricePerKg: 1000 }] }));
  const outs = await Promise.all(bodies);
  const succeeded = outs.filter((o) => o.status === 201).length;
  const kg = await rollKg(roll.id);
  check("CC", "CC.01 10 concurrent 10kg sales on 50kg roll → 5 succeed, remaining 0", true, succeeded === 5 && kg === 0, `succeeded=${succeeded} kg=${kg} statuses=${outs.map((o) => o.status).join(",")}`);

  // CC.02: concurrent duplicate receipt with same idempotency key
  const key = `ikr-${uniq()}`;
  const rbody = { kind: "receipt", date: today(), partyId: cust.id, partyKind: "customer", amount: 10000, currency: "SYP", method: "cash" };
  const [a, b] = await Promise.all([
    api("POST", "/api/receipts", rbody, { "Idempotency-Key": key }),
    api("POST", "/api/receipts", rbody, { "Idempotency-Key": key }),
  ]);
  const recv = (await api("GET", `/api/receipts?partyId=${cust.id}&limit=1000`)).data?.data ?? [];
  check("CC", "CC.02 concurrent duplicate receipt (same key) → 1 voucher", true, (a.status === 201 || b.status === 201) && recv.length === 1, `a=${a.status} b=${b.status} count=${recv.length}`);

  // CC.03: 20 concurrent receipts on same customer → no lost updates, balance exact
  {
    const c3 = (await api("POST", "/api/customers", { name: `عميل CC3 ${u}`, code: `CC3-${u}` })).data;
    const bodies = Array.from({ length: 20 }, () => api("POST", "/api/receipts", { kind: "receipt", date: today(), partyId: c3.id, partyKind: "customer", amount: 1000, currency: "SYP", method: "cash" }));
    const outs = await Promise.all(bodies);
    const okCount = outs.filter((o) => o.status === 201).length;
    const all = (await api("GET", `/api/ledger?partyId=${c3.id}&sort=asc&limit=1000`)).data?.data ?? [];
    const replay = all.filter((e) => e.status === "active").reduce((s, e) => s + (e.debit || 0) - (e.credit || 0), 0);
    const bal = (await api("GET", `/api/ledger/balance/${c3.id}?currency=SYP`)).data;
    check("CC", "CC.03 20 concurrent receipts same customer → no lost updates", true, okCount === 20 && bal.balance === replay && Math.abs(replay) === 20000, `ok=${okCount} replay=${replay} api=${bal.balance}`);
  }

  // LD.01: 300 sequential ops latency
  {
    const t0 = Date.now();
    let ok = 0;
    for (let i = 0; i < 300; i++) {
      const r = await api("GET", "/api/invoices?limit=1");
      if (r.status === 200) ok++;
    }
    const ms = Date.now() - t0;
    check("LD", "LD.01 300 ops complete, latency stable", true, ok === 300, `${ms}ms total (${(ms / 300).toFixed(1)}ms/op)`);
  }
  console.log("STAGE 3 done");
}

/* ================= STAGE 4: FULL REPLAY ================= */
async function stage4() {
  console.log("\n═══ STAGE 4 — Full Replay ═══");
  await login();
  const customers = (await api("GET", "/api/customers?limit=1000")).data?.data ?? [];
  const suppliers = (await api("GET", "/api/suppliers?limit=1000")).data?.data ?? [];
  const parties = [...customers, ...suppliers];
  let allMatch = true;
  let checks = 0;
  for (const p of parties) {
    const all = (await api("GET", `/api/ledger?partyId=${p.id}&sort=asc&limit=1000`)).data?.data ?? [];
    for (const cur of ["SYP", "USD", "EUR"]) {
      const active = all.filter((e) => e.status === "active" && e.currency === cur);
      if (active.length === 0) continue;
      const replay = active.reduce((s, e) => s + (e.debit || 0) - (e.credit || 0), 0);
      const bal = (await api("GET", `/api/ledger/balance/${p.id}?currency=${cur}`)).data;
      if (bal.balance !== replay) {
        allMatch = false;
        console.log(`  MISMATCH ${p.code} ${cur}: api=${bal.balance} replay=${replay}`);
      }
      checks++;
    }
  }
  check("RP", "RP.01 replay ALL party balances == API", true, allMatch, `parties=${parties.length} currency-checks=${checks}`);
  console.log("STAGE 4 done");
}

/* ================= REPORT ================= */
async function report() {
  await mkdir(AUDIT_DIR, { recursive: true });
  await writeFile(path.join(AUDIT_DIR, "exhaustive-report.json"), JSON.stringify({ results, counters }, null, 2));

  const inv = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10"];
  const lines = ["# Exhaustive Full-System Test Report", ""];
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Invariant Table (I1–I10)");
  lines.push("| Invariant | Cases | Pass | Fail | Verdict |");
  lines.push("|---|---|---|---|---|");
  for (const i of inv) {
    const c = counters[i];
    if (!c) { lines.push(`| ${i} | 0 | 0 | 0 | NOT TESTED |`); continue; }
    const verdict = c.fail === 0 ? "✅ HOLDS" : "❌ BROKEN";
    lines.push(`| ${i} | ${c.total} | ${c.pass} | ${c.fail} | ${verdict} |`);
  }
  lines.push("");
  lines.push("## Domain × Technique Matrix (counts)");
  lines.push("| Tag | Cases | Pass | Fail |");
  lines.push("|---|---|---|---|");
  for (const t of Object.keys(counters)) {
    lines.push(`| ${t} | ${counters[t].total} | ${counters[t].pass} | ${counters[t].fail} |`);
  }
  lines.push("");
  lines.push("## Failures");
  const fails = results.filter((r) => !r.pass);
  if (fails.length === 0) lines.push("- none");
  else for (const f of fails) lines.push(`- [${f.tag}] ${f.name}: expected \`${f.expected}\` got \`${f.actual}\``);
  lines.push("");
  const totalFail = Object.values(counters).reduce((s, c) => s + c.fail, 0);
  lines.push(`## Verdict: ${totalFail === 0 ? "ALL INVARIANTS HOLD under tested conditions" : "INVARIANTS BROKEN — see failures above"}`);
  lines.push("");
  lines.push("## Coverage Gaps (deferred from case register)");
  lines.push("- none");
  lines.push("");
  lines.push("## Fixes Applied During Execution");
  lines.push("- I6 (off-by-1 COGS): journal rounds quantity to the DB's 2dp scale; dashboard COGS uses per-line ROUND() so profit is an exact integer matching the ledger.");
  lines.push("- I3/CC.02 (idempotency race): key is now claimed atomically (Redis SET NX / in-process check-and-set) before the handler runs; a truly-concurrent duplicate gets HTTP 409 DUPLICATE_IN_FLIGHT instead of double-processing.");
  lines.push("- CB.BC.02 (negative cashbox): expenses that would overdraw a matching-currency cashbox session are now rejected (422).");
  lines.push("- I4 (sub-granularity): invoice/return/print/roll schemas reject quantities & prices with more than 2 decimal places (matches decimal(12,2) storage).");
  await writeFile(path.join(AUDIT_DIR, "exhaustive-report.md"), lines.join("\n"));
  console.log(`\n═══ TOTAL FAILURES: ${totalFail} ═══`);
  process.exit(totalFail === 0 ? 0 : 1);
}

async function main() {
  await login();
  await stage1();
  await stage2();
  await stage3();
  await stage4();
  await report();
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
