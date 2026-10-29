// Compares the phone's S5 output with the seed file written by scripts/parity/seed-sync-volume.mjs.
// Usage: node mobile/scripts/s5-compare.mjs s5.json '<S5-COUNTS line>' '<S5-BALANCES line>'
import { readFileSync } from "node:fs";

const [file, countsLine, balancesLine] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(file, "utf8"));
const cents = (v) => Math.round(Number(v) * 100);
const expected = {};
for (const per of Object.values(seed.partyBalances)) {
  for (const [currency, remaining] of Object.entries(per)) {
    expected[currency] = (expected[currency] ?? 0) + cents(remaining);
  }
}
const counts = Object.fromEntries(
  [...countsLine.matchAll(/(\w+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]),
);
const receivables = JSON.parse(/receivables=(\{.*?\}) payables/.exec(balancesLine)?.[1] ?? "{}");
let differences = 0;
const check = (name, a, b) => {
  const ok = a === b;
  if (!ok) differences += 1;
  console.log(`${ok ? "OK  " : "DIFF"} ${name}: phone=${a} seed=${b}`);
};
check("invoices", counts.invoices, seed.counts.invoices);
check("parties", counts.parties, seed.counts.parties);
for (const [currency, total] of Object.entries(expected)) {
  check(`receivables ${currency}`, cents(receivables[currency] ?? 0), total);
}
console.log(`${differences} differences`);
process.exit(differences === 0 ? 0 : 1);
