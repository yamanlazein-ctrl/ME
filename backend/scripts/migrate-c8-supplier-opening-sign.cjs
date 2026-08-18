// One-time data migration for C-8 (forensic audit 2026-08-15): corrects
// the running-balance contribution of every supplier's `type = 'opening'`
// ledger row that was written before the sign-convention fix in
// PostgresPartyRepository.ts (see docs/decisions.md D-003).
//
// Does NOT edit or delete the original 'opening' / 'opening_equity' rows —
// the append-only trigger (0013) blocks that anyway, and financial
// corrections in this system should be additive, not destructive. Instead,
// for every supplier whose stored opening row still has credit > debit
// (the old, wrong convention), this posts a balanced correcting
// adjustment/adjustment_contra pair sized to shift that row's contribution
// from the old (wrong) sign to the new (correct) one.
//
// Safe to re-run: a supplier whose opening row already has
// debit >= credit (correct convention, or already corrected) is skipped.
//
// Usage: DATABASE_URL=postgresql://... node migrate-c8-supplier-opening-sign.cjs [--dry-run]
const { Client } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }
  const dryRun = process.argv.includes("--dry-run");
  const c = new Client({ connectionString });
  await c.connect();

  // Idempotency guard added after a real double-application bug was
  // caught live in this session: the original query only inspected the
  // immutable 'opening' row, which never changes even after a correction
  // is posted next to it — so re-running the script kept finding the same
  // "wrong" opening row and posting a SECOND correcting pair, overshooting
  // the target balance. The fix: exclude any supplier that already has a
  // referenceType='c8_sign_correction' row posted against it.
  const suppliers = await c.query(`
    select p.id, p.tenant_id, p.name, p.code, l.debit, l.credit, l.currency
    from parties p
    join ledger_entries l on l.reference_id = p.id and l.type = 'opening'
    where p.kind = 'supplier'
      and l.credit::numeric > l.debit::numeric
      and not exists (
        select 1 from ledger_entries corr
        where corr.reference_id = p.id
          and corr.reference_type = 'c8_sign_correction'
      )
  `);

  if (suppliers.rows.length === 0) {
    console.log("No suppliers need correction.");
    await c.end();
    return;
  }

  for (const s of suppliers.rows) {
    const debit = Number(s.debit);
    const credit = Number(s.credit);
    // Old wrong contribution (uniform mult=1 formula): debit - credit.
    // Target correct contribution: credit - debit (what it should have
    // been had debit/credit been written the other way around).
    // Correction needed = target - old = (credit - debit) - (debit - credit)
    //                    = 2 * (credit - debit).
    const correction = 2 * (credit - debit);
    console.log(
      `${dryRun ? "[DRY RUN] " : ""}${s.name} (${s.code}): opening debit=${debit} credit=${credit} -> ` +
        `posting correcting adjustment debit=${correction} / adjustment_contra credit=${correction} ${s.currency}`,
    );
    if (dryRun) continue;

    const admin = await c.query("select id from users where tenant_id = $1 limit 1", [s.tenant_id]);
    const createdBy = admin.rows[0]?.id ?? null;

    await c.query("BEGIN");
    try {
      await c.query(
        `insert into ledger_entries (tenant_id, party_id, date, type, debit, credit, currency, cash_impact, reference_type, reference_id, reference_number, description, created_by)
         values ($1, $2, current_date, 'adjustment', $3, 0, $4, 'none', 'c8_sign_correction', $2, $5, $6, $7)`,
        [
          s.tenant_id,
          s.id,
          correction,
          s.currency,
          s.code,
          `تصحيح اتجاه الرصيد الافتتاحي (C-8) — القيد الأصلي كُتب دائناً بدل مديناً؛ هذا القيد التصحيحي يعيد التوازن دون حذف أو تعديل السجل القديم`,
          createdBy,
        ],
      );
      await c.query(
        `insert into ledger_entries (tenant_id, party_id, date, type, debit, credit, currency, cash_impact, reference_type, reference_id, reference_number, description, created_by)
         values ($1, NULL, current_date, 'adjustment_contra', 0, $2, $3, 'none', 'c8_sign_correction', $4, $5, $6, $7)`,
        [
          s.tenant_id,
          correction,
          s.currency,
          s.id,
          s.code,
          `مقابل تصحيح اتجاه الرصيد الافتتاحي (C-8) لـ ${s.name} / ${s.code}`,
          createdBy,
        ],
      );
      await c.query("COMMIT");
      console.log(`  -> committed for ${s.code}`);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }

  await c.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
