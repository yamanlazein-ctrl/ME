/**
 * LOCK-IN TESTS — permanent guards against the exact regression patterns found
 * in the 2026-08-25 audit. Run: npm run test:lock  (or: node tests/lock-in.test.mjs)
 *
 * BUG-01 taught us that an uncommitted wide refactor silently deleted the single
 * line `tx.insert(ledgerEntries)` from PostgresReturnRepository.create() —
 * returns kept "working" (stock moved!) while writing ZERO journal rows.
 * These guards make such a deletion fail loudly forever.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoSrc = (p) => fs.readFileSync(path.join(here, "..", "src", p), "utf8");

let failed = 0;
function lock(id, desc, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} [LOCK-${id}] ${desc}`);
  if (!cond) failed++;
}

// ── BUG-01 lock: the ledger INSERT must exist in the returns repository ──
const returnRepo = repoSrc(path.join("infrastructure", "repositories", "PostgresReturnRepository.ts"));
lock(
  "01a",
  "BUG-01: PostgresReturnRepository still CALLS tx.insert(ledgerEntries) — returns must journal",
  /tx\s*\.\s*insert\(ledgerEntries\)/.test(returnRepo),
);
lock(
  "01b",
  "BUG-01: the insert is actually REACHED (not dead code): insert follows legs construction",
  /legs\.length\s*>\s*0[^]*?tx\s*\.\s*insert\(ledgerEntries\)/.test(returnRepo),
);

// ── BUG-02 lock: balanced leg sets ──
lock(
  "02a",
  "BUG-02: sale return posts a sales_return_contra debit (revenue reversal)",
  returnRepo.includes('"sales_return_contra"'),
);
lock(
  "02b",
  "BUG-02: entry return DEBITS the party (supplier debt decreases, C-8 convention)",
  /legFx\(saleTotal,\s*0\)[^]*?type:\s*returnRefType/.test(returnRepo),
);
lock(
  "02c",
  "BUG-03: return FX is derived server-side from the ORIGINAL invoice (no client rate)",
  /linkedInvoiceFx/.test(returnRepo) && !/input\.exchangeRate \?\? null/.test(returnRepo),
);

// ── BUG-03 lock: invoices freeze FX at creation ──
const invoiceRepo = repoSrc(path.join("infrastructure", "repositories", "PostgresInvoiceRepository.ts"));
lock(
  "03a",
  "BUG-03: invoice create persists exchangeRate/baseTotal/basePaid",
  /exchangeRate:\s*fxRate/.test(invoiceRepo) && /baseTotal:\s*computeBaseEquivalent/.test(invoiceRepo),
);

// ── BUG-04 lock: profit report adjusts for returns ──
const profitRepo = repoSrc(path.join("infrastructure", "repositories", "PostgresProfitRepository.ts"));
lock("04a", "BUG-04: profit rows subtract active-return adjustments", profitRepo.includes("getReturnAdjustments"));

// ── BUG-05/06 locks: printing chain ──
const printRepo = repoSrc(path.join("infrastructure", "repositories", "PostgresPrintJobRepository.ts"));
lock("05a", "BUG-05: printed result roll carries remainingPieces (sellable)", /remainingPieces:\s*resultPieces/.test(printRepo));
lock(
  "06a",
  "BUG-06: no separate printing EXPENSE row; cost capitalized as inventory_asset",
  !/insert\(expenses\)/.test(printRepo) && /Printing cost capitalized/.test(printRepo),
);

console.log(failed === 0 ? "\nALL LOCK-IN GUARDS PASS" : `\n${failed} LOCK-IN GUARD(S) FAILED`);
process.exit(failed === 0 ? 0 : 2);
