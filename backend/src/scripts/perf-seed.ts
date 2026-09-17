/**
 * TEMPORARY performance/scale audit seeding script.
 * Not part of the product — written for a one-off QA perf run against the
 * isolated `erp_qa_audit` database, and deleted after use.
 *
 * Creates PERF- prefixed master data (customers, suppliers, fabrics, colors,
 * rolls with effectively unlimited stock) and bulk-generates >=20,000 sale
 * invoices by calling the REAL use-case functions in-process (same DB pool,
 * same repositories, same business rules as the HTTP route) — no browser,
 * no HTTP layer.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import dotenv from "dotenv";

// Force-load the QA env file BEFORE any app module (container.ts -> env.ts)
// runs its own `dotenv.config({path:".env"})`. dotenv does NOT override
// already-set process.env keys by default, so pre-loading .env.qa here with
// override:true guarantees this script talks ONLY to erp_qa_audit, no matter
// what backend/.env points at. All app imports are dynamic (below, inside
// main()) so this runs first regardless of ESM import hoisting.
dotenv.config({ path: ".env.qa", override: true });

import { and, eq } from "drizzle-orm";
import type { TenantContext } from "../domain/types/index.js";
import type { CreateInvoiceLineInput } from "../domain/entities/Invoice.js";

const TENANT_ID = "ddb8adcd-fa06-4743-a8bb-9fb4e7a03691";
const ADMIN_EMAIL = "qa-admin@erp-audit.local";
const OUT_DIR = "C:\\Users\\Taw\\AppData\\Local\\Temp\\claude\\C--Users-Taw-Downloads-Compressed-q-ME-main\\6e664f75-3223-4d68-95e9-2b27d532c03e\\scratchpad";
const N_INVOICES = Number(process.env.PERF_N ?? 20000);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 20);
const SKIP_MASTER = process.env.PERF_SKIP_MASTER === "1";

function rnd(n: number) {
  return Math.floor(Math.random() * n);
}
function pick<T>(arr: T[]): T {
  return arr[rnd(arr.length)];
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

async function asyncPool<T, R>(
  concurrency: number,
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  onResult: (r: R | null, err: unknown | null, idx: number) => void,
) {
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        const r = await fn(items[i], i);
        onResult(r, null, i);
      } catch (err) {
        onResult(null, err, i);
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const { buildContainer } = await import("../infrastructure/di/container.js");
  const { runWithTenantContext } = await import("../infrastructure/orm/tenant-context.js");
  const { db } = await import("../infrastructure/orm/drizzle.js");
  const { users } = await import("../infrastructure/orm/schemas/user.table.js");
  const partyUC = await import("../application/use-cases/parties/partyUseCases.js");
  const fabricUC = await import("../application/use-cases/inventory/fabricUseCases.js");
  const colorUC = await import("../application/use-cases/inventory/colorUseCases.js");
  const rollUC = await import("../application/use-cases/inventory/rollUseCases.js");
  const invoiceUC = await import("../application/use-cases/invoices/invoiceUseCases.js");

  console.log("DATABASE_URL in use:", process.env.DATABASE_URL);
  const c = buildContainer();

  await runWithTenantContext({ tenantId: TENANT_ID }, async () => {
    const [admin] = await db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, TENANT_ID), eq(users.email, ADMIN_EMAIL)))
      .limit(1);
    if (!admin) throw new Error(`admin user ${ADMIN_EMAIL} not found for tenant ${TENANT_ID}`);

    const ctx: TenantContext = {
      tenantId: TENANT_ID,
      userId: admin.id,
      userRole: "admin",
      userName: "QA Perf Seed",
      syncDeviceId: null,
    };

    type ColorRec = { id: string; fabricId: string };
    type RollRec = { id: string; fabricId: string; colorId: string; currency: string; pricePerKg: number };
    let customers: { id: string; name: string }[] = [];
    let suppliers: { id: string; name: string }[] = [];
    let fabrics: { id: string; name: string; colors: ColorRec[] }[] = [];
    let rolls: RollRec[] = [];
    let t0 = Date.now();
    let t1 = t0;

    const masterFile = `${OUT_DIR}/perf-master-data.json`;
    if (SKIP_MASTER && existsSync(masterFile)) {
      console.log("=== Phase 1: master data (loaded from cache) ===");
      const cached = JSON.parse(readFileSync(masterFile, "utf8"));
      customers = cached.customers;
      suppliers = cached.suppliers;
      fabrics = cached.fabrics;
      rolls = cached.rolls;
      console.log(
        `  loaded customers=${customers.length} suppliers=${suppliers.length} fabrics=${fabrics.length} rolls=${rolls.length}`,
      );
      t1 = t0;
    } else {
    console.log("=== Phase 1: master data ===");

    // ---- Customers (30) ----
    for (let i = 1; i <= 30; i++) {
      const currency = i % 4 === 0 ? "USD" : "SYP";
      const r = await partyUC.createPartyUseCase(
        c.partyRepo,
        {
          kind: "customer",
          name: `PERF-Customer-${String(i).padStart(3, "0")}`,
          city: pick(["دمشق", "حلب", "حمص", "اللاذقية", "طرطوس"]),
          currency,
          creditLimit: 0,
        },
        ctx,
      );
      if (!r.ok) throw new Error(`customer ${i}: ${r.error}`);
      customers.push({ id: r.data.id, name: r.data.name });
    }
    console.log(`  customers: ${customers.length}`);

    // ---- Suppliers (10) ----
    for (let i = 1; i <= 10; i++) {
      const r = await partyUC.createPartyUseCase(
        c.partyRepo,
        { kind: "supplier", name: `PERF-Supplier-${String(i).padStart(2, "0")}` },
        ctx,
      );
      if (!r.ok) throw new Error(`supplier ${i}: ${r.error}`);
      suppliers.push({ id: r.data.id, name: r.data.name });
    }
    console.log(`  suppliers: ${suppliers.length}`);

    // ---- Fabrics (15) + Colors (3-5 each) ----
    for (let i = 1; i <= 15; i++) {
      const fr = await fabricUC.createFabricUseCase(
        c.fabricRepo,
        { name: `PERF-Fabric-${String(i).padStart(2, "0")}`, category: "PERF", unit: "kg" },
        ctx,
      );
      if (!fr.ok) throw new Error(`fabric ${i}: ${fr.error}`);
      const colorCount = 3 + (i % 3); // 3..5
      const colors: ColorRec[] = [];
      for (let j = 1; j <= colorCount; j++) {
        const cr = await colorUC.createColorUseCase(
          c.colorRepo,
          { fabricId: fr.data.id, name: `PERF-Color-${j}`, code: `C${j}` },
          ctx,
        );
        if (!cr.ok) throw new Error(`color ${i}/${j}: ${cr.error}`);
        colors.push({ id: cr.data.id, fabricId: fr.data.id });
      }
      fabrics.push({ id: fr.data.id, name: fr.data.name, colors });
    }
    console.log(`  fabrics: ${fabrics.length}, colors: ${fabrics.reduce((s, f) => s + f.colors.length, 0)}`);

    // ---- Rolls: 4 per color, alternating USD/SYP, effectively unlimited stock ----
    let rollSeq = 1;
    for (const fabric of fabrics) {
      for (const color of fabric.colors) {
        for (let k = 0; k < 4; k++) {
          const currency = k % 2 === 0 ? "USD" : "SYP";
          const pricePerKg = currency === "USD" ? round2(2 + Math.random() * 8) : round2(20000 + Math.random() * 50000);
          const rr = await rollUC.createRollUseCase(
            c.rollRepo,
            {
              colorId: color.id,
              rollNo: `PERF-ROLL-${String(rollSeq++).padStart(5, "0")}`,
              initialKg: 5_000_000,
              remainingKg: 5_000_000,
              pieces: 1_000_000,
              remainingPieces: 1_000_000,
              pricePerKg,
              currency,
              entryDate: "2023-01-01",
              supplierId: pick(suppliers).id,
            },
            ctx,
          );
          if (!rr.ok) throw new Error(`roll ${rollSeq}: ${rr.error}`);
          rolls.push({ id: rr.data.id, fabricId: fabric.id, colorId: color.id, currency, pricePerKg });
        }
      }
    }
    console.log(`  rolls: ${rolls.length}`);

    t1 = Date.now();
    console.log(`Master data seeded in ${((t1 - t0) / 1000).toFixed(1)}s`);

    writeFileSync(
      masterFile,
      JSON.stringify({ customers, suppliers, fabrics, rolls, seededAtMs: t1 - t0 }, null, 2),
    );
    } // end master-data else branch

    // ==== Phase 2: bulk invoices ====
    console.log("=== Phase 2: bulk invoices ===");
    const rollsByCurrency: Record<string, RollRec[]> = { USD: [], SYP: [] };
    for (const r of rolls) rollsByCurrency[r.currency].push(r);

    const now = Date.now();
    const twoYearsMs = 2 * 365 * 24 * 3600 * 1000;

    type Spec = { idx: number };
    const specs: Spec[] = Array.from({ length: N_INVOICES }, (_, i) => ({ idx: i }));

    let ok = 0;
    let fail = 0;
    const errorSamples: Record<string, { count: number; sample: string }> = {};
    const latencies: number[] = [];
    const t2 = Date.now();
    let lastLog = t2;

    await asyncPool(
      CONCURRENCY,
      specs,
      async (spec) => {
        const currency = Math.random() < 0.6 ? "SYP" : "USD";
        const candidateRolls = rollsByCurrency[currency];
        const lineCount = 1 + rnd(20); // 1..20
        const customer = pick(customers);
        const dateMs = now - rnd(twoYearsMs);
        const date = new Date(dateMs).toISOString().slice(0, 10);

        const usedRolls = new Set<string>();
        const lines: CreateInvoiceLineInput[] = [];
        for (let li = 0; li < lineCount; li++) {
          let roll = pick(candidateRolls);
          // avoid duplicate rollId within one invoice (a few retries is fine)
          let tries = 0;
          while (usedRolls.has(roll.id) && tries < 5) {
            roll = pick(candidateRolls);
            tries++;
          }
          usedRolls.add(roll.id);
          const quantityKg = round2(1 + Math.random() * 49); // 1..50kg
          const markup = 1.15 + Math.random() * 0.6; // 15%-75% markup over cost
          const pricePerKg = round2(roll.pricePerKg * markup);
          lines.push({
            fabricId: roll.fabricId,
            colorId: roll.colorId,
            rollId: roll.id,
            quantityKg,
            pieces: 1,
            pricePerKg,
            discountAmount: Math.random() < 0.2 ? round2(Math.random() * 5) : 0,
          });
        }

        const subtotal = lines.reduce((s, l) => s + round2(l.quantityKg * l.pricePerKg - (l.discountAmount ?? 0)), 0);
        const discount = Math.random() < 0.15 ? round2(subtotal * 0.02) : 0;
        const tax = 0;
        const shipping = Math.random() < 0.1 ? round2(5 + Math.random() * 20) : 0;
        const total = round2(subtotal - discount + tax + shipping);

        const payMix = Math.random();
        let paid = 0;
        let paymentMethod: "cash" | "transfer" | "check" | "card" | undefined;
        if (payMix < 0.4) {
          paid = 0; // unpaid
        } else if (payMix < 0.7) {
          paid = round2(total * (0.2 + Math.random() * 0.6)); // partial
          paymentMethod = pick(["transfer", "check", "card"]);
        } else {
          paid = total; // fully paid
          paymentMethod = pick(["transfer", "check", "card", "cash"]);
        }

        const exchangeRate = currency === "USD" ? 1 : 13000;

        const input = {
          type: "sale" as const,
          date,
          partyId: customer.id,
          partyType: "customer" as const,
          currency,
          lines,
          discount,
          tax,
          shipping,
          paid,
          paymentMethod,
          exchangeRate,
          notes: `PERF seed invoice #${spec.idx + 1}`,
        };

        const lt0 = Date.now();
        const r = await invoiceUC.createInvoiceUseCase(c.invoiceRepo, c.auditRepo, input, ctx);
        const lt1 = Date.now();
        if (Math.random() < 0.02) latencies.push(lt1 - lt0); // sample ~2%
        if (!r.ok) throw new Error(r.error);
        return r.data.id;
      },
      (_r, err, i) => {
        if (err) {
          fail++;
          const msg = err instanceof Error ? err.message : String(err);
          const key = msg.slice(0, 80);
          if (!errorSamples[key]) errorSamples[key] = { count: 0, sample: msg };
          errorSamples[key].count++;
        } else {
          ok++;
        }
        const total = ok + fail;
        if (total % 1000 === 0 || Date.now() - lastLog > 15000) {
          lastLog = Date.now();
          const elapsed = (Date.now() - t2) / 1000;
          console.log(
            `  progress ${total}/${N_INVOICES} ok=${ok} fail=${fail} elapsed=${elapsed.toFixed(1)}s rate=${(total / elapsed).toFixed(1)}/s`,
          );
        }
      },
    );

    const t3 = Date.now();
    const summary = {
      nRequested: N_INVOICES,
      ok,
      fail,
      wallClockMs: t3 - t2,
      wallClockSec: (t3 - t2) / 1000,
      ratePerSec: ok / ((t3 - t2) / 1000),
      concurrency: CONCURRENCY,
      latencySampleMs: latencies,
      latencyAvgMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      latencyMaxMs: latencies.length ? Math.max(...latencies) : null,
      latencyP95Ms: latencies.length
        ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]
        : null,
      errorSamples,
      masterDataMs: t1 - t0,
    };
    console.log("=== DONE ===");
    console.log(JSON.stringify(summary, null, 2));
    writeFileSync(`${OUT_DIR}/perf-invoice-seed-summary.json`, JSON.stringify(summary, null, 2));
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("perf-seed failed:", err);
    process.exit(1);
  });
